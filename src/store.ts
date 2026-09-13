/**
 * SQLite storage: indexing, integrity, owned edits and atomic local commits.
 * Runtime handles visibility and the Action gate; this layer checks the full
 * stored graph and applies changes. It has no actor-scoped view, because even
 * a hidden endpoint matters to existence and cardinality constraints.
 */
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { Database } from 'better-sqlite3'
import { isPlainJson, reject } from './model.js'
import type {
  ActionName, AuditEntry, Edit, LinkName, ObjectInstance, ObjectName,
  ObjectTypeDef, OntologyDef, Properties, Violation,
} from './model.js'

// A successful preflight still needs to roll back. This sentinel distinguishes
// that intended rollback from a validation failure, which must reach the caller.
class Rollback extends Error {}

/** Internal concrete store. Application writes enter through Runtime actions. */
export class Store<Model extends OntologyDef = OntologyDef> {
  readonly ontology: Model
  readonly #db: Database
  readonly #schemas = new Map<string, z.ZodObject<Properties>>()

  constructor(ontology: Model, db: Database) {
    this.ontology = ontology
    this.#db = db
    for (const [name, obj] of Object.entries(ontology.objects)) {
      this.#schemas.set(name, z.object(obj.properties))
    }
    // objects holds effective JSON rows; links holds instance pairs whose types
    // come from the model. Including type/name in keys keeps identities distinct.
    // overlay holds current owned patches for re-indexing, while audit_log holds
    // the history of Action attempts. An overlay is state, not an event log.
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS objects (
        type TEXT NOT NULL, pk TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (type, pk)
      );
      CREATE TABLE IF NOT EXISTS links (
        name TEXT NOT NULL, from_pk TEXT NOT NULL, to_pk TEXT NOT NULL,
        PRIMARY KEY (name, from_pk, to_pk)
      );
      -- The edit layer for ontology-owned properties on source-backed rows:
      -- the current effective patch per object, reapplied over a re-indexed
      -- base. Ontology-owned types and links need no overlay — load() cannot
      -- touch them, so they survive in place.
      CREATE TABLE IF NOT EXISTS overlay (
        type TEXT NOT NULL, pk TEXT NOT NULL, patch TEXT NOT NULL,
        PRIMARY KEY (type, pk)
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
        target TEXT NOT NULL, params TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('applied', 'rejected')),
        error TEXT, edits TEXT
      );
    `)
  }

  /**
   * Replace supplied source-backed types and reapply their owned overlays in
   * one transaction. Validate all surviving links before commit: even an
   * untouched link can lose its endpoint during a partial refresh.
   * Runtime.load documents the caller-facing indexing contract.
   */
  load(snapshot: {
    objects?: { [K in ObjectName<Model>]?: Record<string, unknown>[] }
    links?: { [Link in LinkName<Model>]?: Array<[from: string, to: string]> }
  }): void {
    this.refuseOpenTransaction('load')
    const insertObject = this.#db.prepare('INSERT INTO objects (type, pk, data) VALUES (?, ?, ?)')
    const insertLink = this.#db.prepare('INSERT OR REPLACE INTO links (name, from_pk, to_pk) VALUES (?, ?, ?)')
    // One transaction covers all supplied types. Check relationships after the
    // replacements, so a snapshot can supply both new endpoints and their links.
    this.#db.transaction(() => {
      const objectEntries = Object.entries(snapshot.objects ?? {}) as Array<[string, Record<string, unknown>[]]>
      for (const [type, rows] of objectEntries) {
        const def = this.ontology.objects[type]
        const schema = this.#schemas.get(type)
        if (!def || !schema) throw new Error(`unknown object type "${type}"`)
        if (def.owned === true) {
          throw new Error(`cannot load "${type}": the type is ontology-owned — no source supplies its rows`)
        }
        const defaults = def.owned ?? {}
        this.#db.prepare('DELETE FROM objects WHERE type = ?').run(type)
        for (const row of rows) {
          // The same strictness as edits, for the same reason: a silently
          // stripped key is an integration bug travelling without a trace.
          const unknown = Object.keys(row).filter((key) => !Object.hasOwn(def.properties, key))
          if (unknown.length > 0) {
            throw new Error(
              `invalid ${type} row: unknown propert${unknown.length > 1 ? 'ies' : 'y'} "${unknown.join('", "')}"`,
            )
          }
          for (const key of Object.keys(defaults)) {
            if (Object.hasOwn(row, key)) {
              throw new Error(`invalid ${type} row: property "${key}" is ontology-owned — a source cannot supply it`)
            }
          }
          const parsed = schema.safeParse({ ...row, ...defaults })
          if (!parsed.success) {
            throw new Error(`invalid ${type} row: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`)
          }
          insertObject.run(type, String(parsed.data[def.primaryKey]), this.#storable(type, parsed.data))
        }
        this.#reapplyOverlay(type)
      }
      const linkEntries = Object.entries(snapshot.links ?? {}) as Array<[string, Array<[string, string]>]>
      for (const [name, pairs] of linkEntries) {
        const link = Object.hasOwn(this.ontology.links, name) ? this.ontology.links[name] : undefined
        if (!link) throw new Error(`unknown link type "${name}"`)
        if (link.owned) {
          throw new Error(`cannot load link "${name}": the link type is ontology-owned — no source supplies its instances`)
        }
        this.#db.prepare('DELETE FROM links WHERE name = ?').run(name)
        for (const [from, to] of pairs) insertLink.run(name, from, to)
      }
      this.#validateLinks()
    })()
  }

  /**
   * Reapply the edit layer over a freshly indexed base. Refusals here roll
   * back the whole load: an orphaned patch means the source dropped a row
   * the ontology still holds owned state for — a reconciliation decision the
   * runtime must not make silently. A patch carrying a key the model no
   * longer declares ontology-owned is the schema-evolution twin of the same
   * problem, refused for the same reason.
   */
  #reapplyOverlay(type: string): void {
    const def = this.ontology.objects[type]!
    const schema = this.#schemas.get(type)!
    const ownedKeys = def.owned && def.owned !== true ? Object.keys(def.owned) : []
    const rows = this.#db.prepare('SELECT pk, patch FROM overlay WHERE type = ?').all(type) as Array<{
      pk: string
      patch: string
    }>
    for (const { pk, patch } of rows) {
      const changes = JSON.parse(patch) as Record<string, unknown>
      const stale = Object.keys(changes).filter((key) => !ownedKeys.includes(key))
      if (stale.length > 0) {
        throw new Error(
          `overlay for ${type}/${pk} carries "${stale.join('", "')}" which the model no longer declares ontology-owned`,
        )
      }
      const base = this.fetch(type, pk)
      if (!base) {
        throw new Error(
          `re-index conflict: ${type}/${pk} carries ontology-owned edits (${Object.keys(changes).join(', ')}) ` +
            'but the re-indexed base no longer has the row — clear the edit or restore the row, then re-load',
        )
      }
      const merged = schema.parse({ ...base, ...changes })
      this.#db
        .prepare('UPDATE objects SET data = ? WHERE type = ? AND pk = ?')
        .run(this.#storable(type, merged), type, pk)
    }
  }

  /** Decode administrative history; rejected targets need not be existing or visible objects. */
  auditLog(filter: { action?: ActionName<Model>; status?: 'applied' | 'rejected'; target?: string } = {}): AuditEntry[] {
    const rows = this.#db.prepare('SELECT * FROM audit_log ORDER BY seq').all() as Array<{
      seq: number
      ts: string
      actor: string
      action: string
      target: string
      params: string
      status: 'applied' | 'rejected'
      error: string | null
      edits: string | null
    }>
    return rows
      .map((r) => ({
        ...r,
        params: JSON.parse(r.params) as Record<string, unknown>,
        error: r.error ? (JSON.parse(r.error) as Violation) : null,
        edits: r.edits ? (JSON.parse(r.edits) as Edit[]) : null,
      }))
      .filter(
        (e) =>
          (!filter.action || e.action === filter.action) &&
          (!filter.status || e.status === filter.status) &&
          (!filter.target || e.target === filter.target),
      )
  }

  /**
   * Inside a caller's transaction, "committed" would mean "until the caller
   * rolls the savepoint back" — an applied-and-audited action could be
   * silently unwound after this runtime reported success. The runtime owns
   * its transactions or refuses to run.
   */
  refuseOpenTransaction(entry: string): void {
    if (this.#db.inTransaction) {
      throw new Error(
        `${entry}() must not run inside an open transaction — ` +
          'a commit that is really a savepoint could be rolled back after success was reported',
      )
    }
  }

  #objectDef(type: string): ObjectTypeDef {
    const def = Object.hasOwn(this.ontology.objects, type) ? this.ontology.objects[type] : undefined
    if (!def) throw new Error(`unknown object type "${type}"`)
    return def
  }

  /**
   * Which side of the authority line an edit falls on, per the model's
   * `owned` declarations — or the Violation for an edit no side can legally
   * hold. Runs after the preflight, so every edit it sees is one the store
   * would accept (empty modifies included: they were already refused).
   * This classifies who owns the state, not which actor is allowed to act.
   */
  editAuthority(edit: Edit): 'source' | 'ontology' | Violation {
    if (edit.op === 'link' || edit.op === 'unlink') {
      const linkDef = Object.hasOwn(this.ontology.links, edit.link) ? this.ontology.links[edit.link] : undefined
      return linkDef?.owned ? 'ontology' : 'source'
    }
    const def = this.#objectDef(edit.object)
    if (def.owned === true) return 'ontology'
    if (edit.op === 'create') {
      return reject(
        'SOURCE_CREATE_UNSUPPORTED',
        `cannot create ${edit.object}/${edit.pk}: the type is source-backed, and creation is supported ` +
          'for ontology-owned types only — creating at the source is undemonstrated, so undeclared',
      )
    }
    const ownedKeys = def.owned ? Object.keys(def.owned) : []
    const touched = Object.keys(edit.changes)
    const owned = touched.filter((key) => ownedKeys.includes(key))
    if (owned.length === 0) return 'source'
    if (owned.length === touched.length) return 'ontology'
    return reject(
      'MIXED_AUTHORITY',
      `edit on ${edit.object}/${edit.pk} changes source-backed and ontology-owned properties together — split it`,
    )
  }

  /**
   * The single validation gate, and the dry run behind the write-back
   * guarantee: the exact code that will commit the plan applies it inside a
   * transaction that always rolls back. No second validator to drift out of
   * sync with the real one.
   */
  preflight(edits: Edit[]): void {
    try {
      this.#db.transaction(() => {
        this.#applyEdits(edits)
        throw new Rollback('preflight')
      })()
    } catch (e) {
      if (!(e instanceof Rollback)) throw e
    }
  }

  /**
   * The gate every stored row passes through: the store keeps JSON, so the
   * value must survive the JSON round trip unchanged — or it would come
   * back a different value. (That the schema also accepts its own output is
   * the model author's declared contract; see ObjectTypeDef.properties.)
   */
  #storable(type: string, value: Record<string, unknown>): string {
    if (!isPlainJson(value)) {
      throw new Error(`${type} row is not plain JSON data — the store cannot hold it faithfully`)
    }
    return JSON.stringify(value)
  }

  /** Raw properties for Runtime reads and integrity checks; Runtime applies visibility. */
  fetch(type: string, pk: string): Record<string, unknown> | undefined {
    this.#objectDef(type)
    const row = this.#db
      .prepare('SELECT data FROM objects WHERE type = ? AND pk = ?')
      .get(type, pk) as { data: string } | undefined
    return row ? JSON.parse(row.data) : undefined
  }

  /**
   * Shared by preflight and commit, each inside its caller's transaction.
   * Plan order is meaningful: create before linking, unlink before rewiring
   * a one-to-many relationship. Do not silently reorder the author's edits.
   */
  #applyEdits(edits: Edit[]): void {
    for (const edit of edits) {
      if (edit.op === 'link' || edit.op === 'unlink') {
        // Object.hasOwn, not a bare index: prototype names (toString,
        // __proto__, …) must not masquerade as link types.
        const linkDef = Object.hasOwn(this.ontology.links, edit.link) ? this.ontology.links[edit.link] : undefined
        if (!linkDef) throw new Error(`unknown link type "${edit.link}"`)
        if (edit.op === 'link') {
          // A link is a statement about two objects — both endpoints must exist.
          if (!this.fetch(linkDef.from, edit.from))
            throw new Error(`cannot link: ${linkDef.from}/${edit.from} does not exist`)
          if (!this.fetch(linkDef.to, edit.to))
            throw new Error(`cannot link: ${linkDef.to}/${edit.to} does not exist`)
          if (linkDef.kind === 'one-to-many') {
            const existing = this.#db
              .prepare('SELECT from_pk FROM links WHERE name = ? AND to_pk = ? AND from_pk != ?')
              .get(edit.link, edit.to, edit.from) as { from_pk: string } | undefined
            if (existing)
              throw new Error(
                `cannot link: ${linkDef.to}/${edit.to} is already linked to ` +
                  `${linkDef.from}/${existing.from_pk} via "${edit.link}" (one-to-many — unlink first)`,
              )
          }
          this.#db
            .prepare('INSERT OR REPLACE INTO links (name, from_pk, to_pk) VALUES (?, ?, ?)')
            .run(edit.link, edit.from, edit.to)
        } else {
          this.#db
            .prepare('DELETE FROM links WHERE name = ? AND from_pk = ? AND to_pk = ?')
            .run(edit.link, edit.from, edit.to)
        }
        continue
      }
      const def = this.#objectDef(edit.object)
      const schema = this.#schemas.get(edit.object)!
      // Unknown keys are refused, not silently stripped: zod would strip
      // them, but the raw edit still travels to the write-back adapter, and
      // a stripped key would let source and store diverge without a trace.
      // Object.hasOwn, not `in`: prototype names are unknown keys too.
      const payload = edit.op === 'create' ? edit.data : edit.changes
      const unknown = Object.keys(payload).filter((key) => !Object.hasOwn(def.properties, key))
      if (unknown.length > 0) {
        throw new Error(`unknown propert${unknown.length > 1 ? 'ies' : 'y'} "${unknown.join('", "')}" on ${edit.object}`)
      }
      if (edit.op === 'create') {
        const data = schema.parse(edit.data)
        if (String(data[def.primaryKey]) !== edit.pk) {
          throw new Error(
            `create pk mismatch for ${edit.object}: edit says "${edit.pk}", data says "${String(data[def.primaryKey])}"`,
          )
        }
        this.#db
          .prepare('INSERT INTO objects (type, pk, data) VALUES (?, ?, ?)')
          .run(edit.object, edit.pk, this.#storable(edit.object, data))
        continue
      }
      // modify. A modify that changes nothing is not an edit — refusing it
      // keeps the authority classification total: every edit has a side.
      if (Object.keys(edit.changes).length === 0) {
        throw new Error(`modify on ${edit.object}/${edit.pk} changes nothing`)
      }
      if (Object.hasOwn(edit.changes, def.primaryKey) && edit.changes[def.primaryKey] !== edit.pk) {
        throw new Error(`cannot modify the primary key of ${edit.object}/${edit.pk}`)
      }
      const current = this.fetch(edit.object, edit.pk)
      if (!current) throw new Error(`cannot modify missing object ${edit.object}/${edit.pk}`)
      // Validate the resulting whole object, not a partial patch against a full
      // schema. Untouched required properties remain present during validation.
      const next = schema.parse({ ...current, ...edit.changes })
      this.#db
        .prepare('UPDATE objects SET data = ? WHERE type = ? AND pk = ?')
        .run(this.#storable(edit.object, next), edit.object, edit.pk)
      // Ontology-owned changes on a source-backed row also land in the
      // overlay — the layer load() reapplies over a re-indexed base. A
      // value set back to its declared default is pruned (compared
      // structurally, so key order cannot hide "back at default"): clearing
      // an edit clears the survival obligation with it.
      if (def.owned && def.owned !== true && this.editAuthority(edit) === 'ontology') {
        const defaults = def.owned
        const row = this.#db
          .prepare('SELECT patch FROM overlay WHERE type = ? AND pk = ?')
          .get(edit.object, edit.pk) as { patch: string } | undefined
        const patch: Record<string, unknown> = row ? (JSON.parse(row.patch) as Record<string, unknown>) : {}
        for (const key of Object.keys(edit.changes)) {
          const value = (next as Record<string, unknown>)[key]
          if (isDeepStrictEqual(value, defaults[key])) delete patch[key]
          else patch[key] = value
        }
        if (Object.keys(patch).length === 0) {
          this.#db.prepare('DELETE FROM overlay WHERE type = ? AND pk = ?').run(edit.object, edit.pk)
        } else {
          this.#db
            .prepare('INSERT OR REPLACE INTO overlay (type, pk, patch) VALUES (?, ?, ?)')
            .run(edit.object, edit.pk, JSON.stringify(patch))
        }
      }
    }
  }

  /**
   * Check every surviving link, including those not replaced by this load.
   * A partial refresh can otherwise remove endpoints of an untouched link.
   */
  #validateLinks(): void {
    for (const [name, link] of Object.entries(this.ontology.links)) {
      const rows = this.#db
        .prepare('SELECT from_pk, to_pk FROM links WHERE name = ?')
        .all(name) as Array<{ from_pk: string; to_pk: string }>
      const parentOf = new Map<string, string>()
      for (const { from_pk, to_pk } of rows) {
        if (!this.fetch(link.from, from_pk))
          throw new Error(`link "${name}": ${link.from}/${from_pk} does not exist`)
        if (!this.fetch(link.to, to_pk))
          throw new Error(`link "${name}": ${link.to}/${to_pk} does not exist`)
        if (link.kind === 'one-to-many') {
          const previous = parentOf.get(to_pk)
          if (previous !== undefined && previous !== from_pk) {
            throw new Error(
              `link "${name}": ${link.to}/${to_pk} is linked to more than one ${link.from} (one-to-many)`,
            )
          }
          parentOf.set(to_pk, from_pk)
        }
      }
    }
  }

  /**
   * Append only. Success calls this inside commit's transaction; Runtime records
   * refusals separately so they survive even though no business edits were applied.
   */
  audit(entry: {
    actor: string
    action: string
    target: string
    params: Record<string, unknown>
    status: 'applied' | 'rejected'
    error?: Violation
    edits?: Edit[]
  }): void {
    this.#db
      .prepare(
        `INSERT INTO audit_log (ts, actor, action, target, params, status, error, edits)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        entry.actor,
        entry.action,
        entry.target,
        safeJson(entry.params),
        entry.status,
        entry.error ? JSON.stringify(entry.error) : null,
        entry.edits ? safeJson(entry.edits) : null,
      )
  }

  /** Raw read rows in stable primary-key order; visibility belongs to Runtime. */
  scan(type: string): ObjectInstance[] {
    this.#objectDef(type)
    const rows = this.#db.prepare('SELECT pk, data FROM objects WHERE type = ? ORDER BY pk').all(type) as {
      pk: string; data: string
    }[]
    return rows.map((r) => ({ type, pk: r.pk, properties: JSON.parse(r.data) }))
  }

  /** Return neighbor IDs; Runtime re-reads endpoints to apply the caller's visibility. */
  related(link: string, direction: 'forward' | 'reverse', pk: string): { pk: string }[] {
    // Reverse traversal swaps fixed column names; link names and IDs remain bound values.
    const [where, select] = direction === 'forward' ? ['from_pk', 'to_pk'] : ['to_pk', 'from_pk']
    return this.#db.prepare(`SELECT ${select} AS pk FROM links WHERE name = ? AND ${where} = ? ORDER BY pk`)
      .all(link, pk) as { pk: string }[]
  }

  /**
   * Local edits and their audit entry commit together. When required, external
   * write-back has already happened in Runtime and cannot be rolled back here.
   * Parameters<...>[0] reuses audit's input shape instead of duplicating it.
   */
  commit(edits: Edit[], entry: Parameters<Store<Model>['audit']>[0]): void {
    this.#db.transaction(() => {
      this.#applyEdits(edits)
      this.audit(entry)
    })()
  }
}

/**
 * Best-effort encoding for rejected raw input: use a placeholder when ordinary
 * JSON encoding fails. This preserves some context instead of losing the entry;
 * it does not suppress database errors or guarantee every value can be logged.
 */
function safeJson(value: unknown): string {
  try {
    const encoded = JSON.stringify(value)
    if (typeof encoded === 'string') return encoded
  } catch {
    // fall through to the placeholder
  }
  return JSON.stringify({ $unserializable: String(value) })
}
