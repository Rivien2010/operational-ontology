/**
 * operational-ontology · core
 *
 * The runtime that interprets the definitions in model.ts:
 *
 *   - objects & links are indexed from existing physical data (read side)
 *   - every write goes through an action: preconditions → effects → audit log
 *   - the API exposes no other write path — a contract on the API, not a
 *     privilege boundary against code holding the database handle (declared;
 *     see "Transaction ownership" in IMPLEMENTATION.md)
 *   - authority is declared in the model: source-backed state comes from the
 *     sources and write-back governs its changes; ontology-owned state lives
 *     here, needs no write-back, and survives re-indexing
 *
 * The ontology definition is a plain value, not a class hierarchy. The
 * runtime interprets it — which is what lets `mcp.ts` enumerate it and expose
 * the same model, guarded by the same rules, to AI agents.
 *
 * Vocabulary: model.ts defines the schema side of the model; the
 * store holds the instance side — object state, link instances, and the
 * audit log, where one entry is one attempted action.
 *
 * Runtime coordinates actor-scoped reads and the Action gate. Store owns
 * SQLite integrity and transactions; query.ts operates on evaluated values.
 * The public methods expose data shapes; runtime checks enforce model constraints.
 */
import { z } from 'zod'
import type { Database } from 'better-sqlite3'

import { defineOntology, isPlainJson, reject } from './model.js'
import { Store } from './store.js'
import * as query from './query.js'
import type { ObjectSet, AggregationResult, AggregationRow, ObjectFilter } from './query.js'
import type {
  ActionCtx, ActionDef, ActionResult, AuditEntry, Edit, ObjectInstance,
  ObjectOf, OntologyDef, TraverseOptions, Violation, OperationResultOf,
} from './model.js'
export * from './model.js'
export { objectSet, aggregationResult } from './query.js'
export type { ObjectSet, AggregationResult, AggregationRow, ObjectFilter } from './query.js'

// ───────────────────────────── Write-back ─────────────────────────────

/**
 * Propagates an action's edits toward the systems of record, running BEFORE
 * the local commit — write-back-first, the declared failure semantics (see
 * "Failure semantics in detail" in IMPLEMENTATION.md). The adapter speaks
 * only to the systems of record; that boundary is a declared contract, not
 * an enforced one (see "Transaction ownership" in IMPLEMENTATION.md). It
 * receives its own copies of the plan and the target object, so nothing it
 * mutates leaks back into the runtime.
 */
export interface WritebackAdapter {
  apply(
    edits: Edit[],
    meta: {
      action: string
      actor: string
      /** The action's target, as the runtime loaded it — routing material. */
      target: ObjectInstance
    },
  ): void
}

// ───────────────────────────── Runtime ─────────────────────────────

const editErrorMessage = (e: unknown): string =>
  e instanceof z.ZodError
    ? `${e.issues[0]?.path.join('.') || 'edit'}: ${e.issues[0]?.message ?? 'invalid'}`
    : e instanceof Error
      ? e.message
      : String(e)

/**
 * The four answers this implementation declares, as one enumerable value —
 * the same move the model makes: a declaration you can read at runtime, not
 * prose you have to trust. Authority is the model's half of the bargain
 * (`owned`, `writeback`, checked per edit plan); the other three are the
 * runtime's. Each is unpacked in the README and IMPLEMENTATION.md.
 */
export const declarations = {
  authority: 'model-declared-runtime-checked',
  failureSemantics: 'write-back-first',
  reindexing: 'replace-base-reapply-owned-overlay',
  visibilityDefault: 'fail-open',
} as const

/**
 * Interpret one model. Model is kept only for simple get/search/run result
 * lookups; operation inputs use strings and plain data, checked at runtime.
 * Store holds ontology state separately from the indexed source systems.
 */
export class Runtime<Model extends OntologyDef = OntologyDef> {
  readonly ontology: Model
  readonly declarations = declarations
  readonly #store: Store
  readonly #writeback?: WritebackAdapter

  constructor(ontology: Model, db: Database, opts: { writeback?: WritebackAdapter } = {}) {
    // A caller may pass a plain definition without using defineOntology first.
    this.ontology = defineOntology(ontology)
    this.#store = new Store(this.ontology, db)
    this.#writeback = opts.writeback
  }

  /**
   * Load a snapshot of integrated physical data into the ontology store —
   * the stand-in for the indexing pipeline, an infrastructure entry point
   * rather than a user write path. Semantics, per loaded type: replace the
   * base, reapply the edit layer. A snapshot speaks only for source-backed
   * state, so anything ontology-owned in it is refused, and an overlay
   * patch whose base row disappeared refuses the whole load. Details:
   * "Re-indexing vs edits" in IMPLEMENTATION.md.
   */
  load(snapshot: {
    objects?: Record<string, Record<string, unknown>[]>
    links?: Record<string, Array<[from: string, to: string]>>
  }): void {
    this.#store.load(snapshot)
  }

  /** The selected type determines properties; hidden and missing IDs both yield undefined. */
  get<K extends string>(type: K, pk: string, opts: { actor: string }): ObjectOf<Model, K> | undefined {
    return this.#read<ObjectOf<Model, K>>(type, pk, opts.actor)
  }

  /** Read visible objects, then apply the caller's predicate to those snapshots. */
  search<K extends string>(type: K, opts: { actor: string; filter?: ObjectFilter<ObjectOf<Model, K>> }): ObjectSet<ObjectOf<Model, K>> {
    const set = query.objectSet(type, this.#scan(type, opts.actor) as ObjectOf<Model, K>[])
    return opts.filter === undefined ? set : query.filterObjects(set, opts.filter)
  }

  /** Links, endpoints and direction are checked from the model at execution time. */
  traverse(source: ObjectInstance, linkName: string, opts: TraverseOptions): ObjectSet {
    if (!source || typeof source.type !== 'string' || typeof source.pk !== 'string' ||
        !source.properties || typeof source.properties !== 'object' || Array.isArray(source.properties)) {
      throw new Error('traverse() requires an object instance with type, pk, and properties')
    }
    return this.#follow(source.type, [source.pk], linkName, opts)
  }

  /** Follow a relationship from a whole set; the output tag is known at runtime. */
  pivot(source: ObjectSet, linkName: string, opts: TraverseOptions): ObjectSet {
    const set = query.objectSet(source.type, source.objects)
    return this.#follow(set.type, set.objects.map((o) => o.pk), linkName, opts)
  }

  /** Filter snapshots or metric rows locally; neither callback is sent over MCP. */
  filter<O extends ObjectInstance>(input: ObjectSet<O>, predicate: ObjectFilter<O>): ObjectSet<O>
  filter<O extends ObjectInstance>(
    input: AggregationResult<O>, predicate: (row: AggregationRow) => boolean,
  ): AggregationResult<O>
  filter(input: ObjectSet | AggregationResult, predicate: unknown): ObjectSet | AggregationResult {
    if ('set' in input) return query.filterAggregation(input, predicate as (row: AggregationRow) => boolean)
    return query.filterObjects(input, predicate as ObjectFilter)
  }

  /** Set algebra checks matching tags at runtime and preserves the left snapshots. */
  union(a: ObjectSet, b: ObjectSet): ObjectSet { return query.combine('union', a, b) }
  intersect(a: ObjectSet, b: ObjectSet): ObjectSet { return query.combine('intersect', a, b) }
  subtract(a: ObjectSet, b: ObjectSet): ObjectSet { return query.combine('subtract', a, b) }

  /** Results have count, plus sum when requested. The schema checks grouping and numeric fields. */
  aggregate<O extends ObjectInstance>(set: ObjectSet<O>, options: { groupBy: string; sum?: string }): AggregationResult<O> {
    const def = Object.hasOwn(this.ontology.objects, set.type) ? this.ontology.objects[set.type] : undefined
    if (!def) throw new Error(`unknown object type "${set.type}"`)
    return query.aggregate(set, options, def.properties)
  }

  /** Traversal always re-reads both ends as this actor; snapshots are not authority. */
  #follow(type: string, pks: readonly string[], linkName: string, opts: TraverseOptions): ObjectSet {
    // Check the schema before iterating: an empty set must not hide a bad link
    // or an ambiguous direction, regardless of the caller's language.
    const link = Object.hasOwn(this.ontology.links, linkName) ? this.ontology.links[linkName] : undefined
    if (!link) throw new Error(`unknown link type "${linkName}"`)
    const forward = type === link.from
    const reverse = type === link.to
    if (!forward && !reverse) throw new Error(`link "${linkName}" does not connect "${type}"`)
    if (forward && reverse && opts.direction === undefined) throw new Error(`link "${linkName}" requires a direction from "${type}"`)
    const direction = opts.direction === undefined ? (forward ? 'forward' : 'reverse') : opts.direction
    if (!((direction === 'forward' && forward) || (direction === 'reverse' && reverse))) {
      throw new Error(`invalid direction "${direction}" for link "${linkName}" from "${type}"`)
    }
    const target = direction === 'forward' ? link.to : link.from
    const objects: ObjectInstance[] = []
    for (const pk of pks) {
      if (!this.#read(type, pk, opts.actor)) continue
      for (const row of this.#store.related(linkName, direction, pk)) {
        const object = this.#read(target, row.pk, opts.actor)
        if (object) objects.push(object)
      }
    }
    // Several sources can reach the same target; a pivot returns objects, not paths.
    return query.objectSet(target, objects)
  }

  /**
   * One entry point for named operations; only actions pass through the write gate.
   * The supplied schema checks params. A Function's result passes
   * through as defined, including a Promise; Action execution is synchronous.
   */
  run<Name extends string>(
    name: Name, params: Record<string, unknown>, opts: { actor: string },
  ): OperationResultOf<Model, Name> {
    if (Object.hasOwn(this.ontology.actions, name)) {
      return this.#runAction(name, params, opts, 'run') as OperationResultOf<Model, Name>
    }
    const functions = this.ontology.functions
    const fn = functions && Object.hasOwn(functions, name) ? functions[name] : undefined
    if (!fn) throw new Error(`unknown operation "${name}"`)
    return fn.run({ params: z.object(fn.params).parse(params), actor: opts.actor })
  }

  /** Validate an action's plan without write-back, commit, or audit. */
  preview(actionName: string, params: Record<string, unknown>, opts: { actor: string }): ActionResult {
    return this.#runAction(actionName, params, opts, 'preview')
  }

  /**
   * Execute an action. This is the only way the API changes state:
   * validate params → load target → preconditions → effects → dry-run the
   * whole plan through the commit's own code → check the authority
   * declaration → write-back (if declared) → atomically commit edits +
   * audit entry. Validity precedes authority: a plan the store would refuse
   * is INVALID_EDITS, whatever else it is.
   */
  #runAction(
    actionName: string, params: unknown, opts: { actor: string }, mode: 'run' | 'preview',
  ): ActionResult {
    this.#store.refuseOpenTransaction(mode)
    // From here on the params are raw input: the schema, not the type, decides.
    const raw = params as Record<string, unknown>
    // Every execution attempt is audited, including early refusals. Previews are reads.
    const refuseAs = (
      target: string,
      auditParams: Record<string, unknown>,
      error: Violation,
      edits?: Edit[],
    ): ActionResult => {
      if (mode === 'run') this.#store.audit({
        actor: opts.actor,
        action: actionName,
        target,
        params: auditParams,
        status: 'rejected',
        error,
        edits,
      })
      return { ok: false, error }
    }

    const action: ActionDef<any, any> | undefined = Object.hasOwn(this.ontology.actions, actionName)
      ? this.ontology.actions[actionName]
      : undefined
    if (!action) {
      return refuseAs('(unknown action)', raw, reject('UNKNOWN_ACTION', `no action named "${actionName}"`))
    }

    const guessTarget = () => {
      const guessed = raw[action.targetParam]
      return `${action.object}/${guessed != null ? String(guessed) : '(invalid)'}`
    }

    // Params are stored verbatim in the audit log, so they must be values
    // the log can hold faithfully — refused here, and still audited (the
    // audit write falls back to a placeholder for what it cannot encode).
    if (!isPlainJson(raw)) {
      return refuseAs(guessTarget(), raw, reject('INVALID_PARAMS', 'params are not plain JSON data'))
    }

    const parsed = z.object(action.params).safeParse(raw)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return refuseAs(
        guessTarget(),
        raw,
        reject('INVALID_PARAMS', `${issue?.path.join('.') ?? 'params'}: ${issue?.message ?? 'invalid'}`),
      )
    }

    const pk = String(parsed.data[action.targetParam])
    const target = `${action.object}/${pk}`
    const refuse = (error: Violation, edits?: Edit[]): ActionResult => refuseAs(target, parsed.data, error, edits)

    // Execution crashes are audited as EXECUTION_CRASHED. Both modes rethrow.
    const crashed = (e: unknown): never => {
      if (mode === 'run') this.#store.audit({
        actor: opts.actor,
        action: actionName,
        target,
        params: parsed.data,
        status: 'rejected',
        error: reject('EXECUTION_CRASHED', e instanceof Error ? e.message : String(e)),
      })
      throw e
    }

    let object: ObjectInstance | undefined
    try {
      // Hidden targets are indistinguishable from missing ones.
      object = this.#read(action.object, pk, opts.actor)
    } catch (e) {
      crashed(e)
    }
    if (!object) return refuse(reject('TARGET_NOT_FOUND', `${target} does not exist`))
    const ctx: ActionCtx = { object, params: parsed.data, actor: opts.actor }

    let edits: Edit[] = []
    try {
      for (const precondition of action.preconditions) {
        const violation = precondition(ctx)
        if (violation) return refuse(violation)
      }
      edits = action.effects(ctx)
    } catch (e) {
      crashed(e)
    }

    // The single validation gate: dry-run the whole plan through the
    // commit's own code before anything leaves this process. Everything the
    // commit would check — unknown keys, schemas, link endpoints,
    // cardinality — is checked here first, so the write-back adapter never
    // sees a plan the ontology store would refuse. (Single-writer,
    // synchronous: nothing can change between this dry run and the commit
    // below.)
    try {
      this.#store.preflight(edits)
    } catch (e) {
      return refuse(reject('INVALID_EDITS', editErrorMessage(e)))
    }

    // The authority line, checked after validity: `writeback` is the
    // action's declared side of it, and the declaration is checked against
    // what the plan actually touches — an undeclared write to source-backed
    // state is exactly the shadow copy the fourth property forbids,
    // whatever the action is named.
    const sides = new Set<'source' | 'ontology'>()
    for (const edit of edits) {
      const side = this.#store.editAuthority(edit)
      if (typeof side !== 'string') return refuse(side)
      sides.add(side)
    }
    if (sides.size > 1) {
      return refuse(
        reject(
          'MIXED_AUTHORITY',
          'the edit plan changes both source-backed and ontology-owned state — ' +
            'plans are routed whole, so split the action along the authority line',
        ),
      )
    }
    const authority = sides.values().next().value
    if (authority === 'source' && !action.writeback) {
      return refuse(
        reject(
          'UNDECLARED_SOURCE_WRITE',
          'the edit plan changes source-backed state but the action does not declare `writeback: true` — ' +
            'a local change to source truth that never travels home is a shadow copy',
        ),
      )
    }
    if (authority === 'ontology' && action.writeback) {
      return refuse(
        reject(
          'MISDECLARED_WRITEBACK',
          'the action declares `writeback: true` but the edit plan changes only ontology-owned state — ' +
            'nothing in it belongs to a source',
        ),
      )
    }

    if (action.writeback && edits.length > 0 && !this.#writeback) {
      return refuse(reject('NO_WRITEBACK_ADAPTER', 'action requires write-back but no adapter is configured'))
    }
    // Preview is a snapshot of local validity, not a reservation or a source
    // acknowledgement. run() runs these checks again against current state.
    if (mode === 'preview') return { ok: true, edits }

    // An empty plan changes nothing, so there is nothing to write back —
    // the attempt still commits an audit entry below.
    if (action.writeback && edits.length > 0) {
      try {
        // Write-back first: if the system of record refuses, nothing changes
        // here. The adapter gets its own copies: what commits below is the
        // plan that was validated, not whatever the adapter left behind.
        this.#writeback!.apply(structuredClone(edits), {
          action: actionName,
          actor: opts.actor,
          target: structuredClone(object),
        })
      } catch (e) {
        // The adapter may have partially applied the plan before throwing —
        // source-side atomicity is the adapter's contract, not this
        // runtime's. The full plan goes on the record as the raw material
        // for reconciliation.
        return refuse(reject('WRITEBACK_FAILED', e instanceof Error ? e.message : String(e)), edits)
      }
    }

    // Edits and their audit entry commit together or not at all.
    try {
      this.#store.commit(edits, { actor: opts.actor, action: actionName, target, params: parsed.data, status: 'applied', edits })
    } catch (e) {
      // The transaction rolled back (its audit entry included) — record the
      // crashed attempt outside it, then surface the error.
      this.#store.audit({
        actor: opts.actor,
        action: actionName,
        target,
        params: parsed.data,
        status: 'rejected',
        error: reject('COMMIT_FAILED', e instanceof Error ? e.message : String(e)),
        // The edits are on the record even though they did not apply: after a
        // write-back-first action, they are what already reached the source.
        edits,
      })
      throw e
    }

    return { ok: true, edits }
  }

  /** Administrative history, not an actor-scoped object query. */
  auditLog(filter: { action?: string; status?: 'applied' | 'rejected'; target?: string } = {}): AuditEntry[] {
    return this.#store.auditLog(filter)
  }

  /** A read snapshot, scoped to the actor. Hidden and missing objects are alike. */
  #read<O extends ObjectInstance = ObjectInstance>(type: string, pk: string, actor: string): O | undefined {
    const properties = this.#store.fetch(type, pk)
    if (properties === undefined) return undefined
    // Store rows use dynamic names; the public signature restores the model's
    // name/property pairing. The assertion itself performs no schema validation.
    const object = { type, pk, properties } as O
    return this.#visible(object, actor) ? object : undefined
  }

  #scan(type: string, actor: string): ObjectInstance[] {
    return this.#store.scan(type).filter((o) => this.#visible(o, actor))
  }

  // Visibility belongs here: Store's integrity checks need the complete graph,
  // including endpoints that this particular caller cannot see.
  #visible(object: ObjectInstance, actor: string): boolean {
    const visibility = this.ontology.objects[object.type]?.visibility
    return visibility ? visibility({ object, actor }) : true
  }
}

/** Preserve the supplied model type instead of returning an unspecialized Runtime. */
export function createRuntime<Model extends OntologyDef>(
  ontology: Model,
  db: Database,
  opts: { writeback?: WritebackAdapter } = {},
): Runtime<Model> {
  return new Runtime(ontology, db, opts)
}
