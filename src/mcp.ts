/**
 * operational-ontology · MCP surface
 *
 * Generates an MCP server from an ontology definition. Because the model is
 * data, the agent-facing tool surface is derived, not hand-written:
 *
 *   - per object type:  search/get/filter/aggregate and set algebra
 *   - per link type:    traverse_<link>, pivot_<link> (both directions)
 *   - per action:       <action>, guarded by the same preconditions as
 *                       every other caller
 *   - per function:     <function>, a model-defined read
 *   - plus:             read_audit_log
 *
 * There is intentionally no raw SQL tool and no generic update tool.
 * The absence is the point: the operation space an agent gets is exactly
 * the operation space the model defines.
 *
 * This file adapts JSON inputs and outputs, derives schemas, and supplies the
 * session actor. Runtime still executes queries and checks Action plans;
 * transport handlers do not reproduce domain rules or write directly to Store.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { objectSet, aggregationResult } from './core.js'
import type { AggregationResult, ObjectInstance, Runtime, TraverseOptions, OntologyDef, Where } from './core.js'
import { fieldInfo, whereSchema, type Condition, type MetricWhere } from './query.js'
import pkg from '../package.json' with { type: 'json' }

/**
 * Enumerate any model at runtime. Unlike a typed application call, these tool
 * names are dynamic strings; Zod schemas and Runtime checks validate their use.
 * Type assertions in handlers bridge that dynamic boundary, not validate input.
 */
export function buildMcpServer(rt: Runtime, opts: { agent?: string } = {}): McpServer {
  // The version an agent sees is the package's — one place to bump.
  const server = new McpServer({ name: `operational-ontology:${rt.ontology.name}`, version: pkg.version })
  // Tool names are derived from model names, so two model names can collide
  // after snake-casing (object `Order` ⇒ search_order, action `searchOrder`
  // ⇒ search_order). Fail at build time with both origins named.
  const claimed = new Map<string, string>()
  const toolName = (name: string, origin: string): string => {
    const holder = claimed.get(name)
    if (holder !== undefined) {
      throw new Error(`MCP tool name collision: "${name}" is derived from both ${holder} and ${origin} — rename one`)
    }
    claimed.set(name, origin)
    return name
  }
  // Over stdio there is no session id, so every caller collapses to one
  // identity — pass opts.agent to name the agent this server serves.
  // This supplies a visibility label; it is not an authentication mechanism.
  const actorOf = (extra?: { sessionId?: string }) => `agent:${extra?.sessionId ?? opts.agent ?? 'mcp'}`
  const asJson = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  })
  // Every handler — reads included — surfaces crashes in the same
  // machine-readable shape as refusals. No stack dumps in an agent's context.
  // A preserves the handler's argument tuple (inputs and session context);
  // R preserves its normal result alongside the added error envelope.
  const guarded =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R | (ReturnType<typeof asJson> & { isError: true })> => {
      try {
        return await fn(...args)
      } catch (e) {
        return {
          ...asJson({ error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } }),
          isError: true as const,
        }
      }
    }
  // IDs select current snapshots, not authority to read them. Missing or hidden
  // objects drop out; caller-supplied properties never replace the stored values.
  const hydrate = (type: string, pks: readonly string[], actor: string) => objectSet(type,
    pks.map((pk) => rt.get(type, pk, { actor })).filter((object) => object !== undefined))
  // Custom Function column names are known only from the supplied aggregation.
  // This checks the envelope; query.filterAggregation checks columns and op/value pairs.
  const metricWhere = z.array(z.object({
    property: z.string().describe('A numeric column named in the aggregation result columns.'),
    op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in']),
    value: z.union([z.number(), z.array(z.number())]),
  }).strict())

  for (const [typeName, def] of Object.entries(rt.ontology.objects)) {
    const where = whereSchema(def.properties)
    server.registerTool(
      toolName(`search_${snake(typeName)}`, `object type ${typeName}`),
      {
        description: `Search ${typeName} objects. Conditions are ANDed and property/operator/value types follow the model. Results are scoped to this session.`,
        inputSchema: z.object({ where: where.optional() }).strict(),
      },
      guarded(async (args: { where?: Condition[] }, extra: { sessionId?: string }) =>
        asJson(rt.search(typeName, { actor: actorOf(extra), filter: args.where as Where<any> | undefined }))),
    )
    server.registerTool(
      toolName(`get_${snake(typeName)}`, `object type ${typeName}`),
      {
        description: `Fetch a single ${typeName} by primary key (${def.primaryKey}).`,
        inputSchema: { [def.primaryKey]: z.string() },
      },
      guarded(async (args: Record<string, unknown>, extra: { sessionId?: string }) =>
        asJson(rt.get(typeName, String(args[def.primaryKey]), { actor: actorOf(extra) }) ?? null)),
    )

    // Accept the result's JSON shape so it can feed a later filter call. Member
    // objects are reloaded below; supplied metrics remain analysis snapshots,
    // not certified facts or values recalculated from the database.
    const aggregation = z.object({
      set: z.object({ type: z.literal(typeName), objects: z.array(z.object({
        type: z.literal(typeName), pk: z.string(), properties: z.record(z.string(), z.unknown()),
      }).strict()) }).strict(),
      columns: z.record(z.string(), z.literal('number')),
      values: z.array(z.object({ key: z.union([z.string(), z.number(), z.boolean()]), pks: z.array(z.string()) }).catchall(z.number())),
    }).strict()
    server.registerTool(
      toolName(`filter_${snake(typeName)}`, `filter ${typeName}`),
      {
        description: `Filter a ${typeName} set by properties, or an aggregation by numeric columns. Pass source={pks:[...]} for objects, or the returned aggregation with set/columns/values. Object snapshots are reloaded as this session; supplied metrics are analysis data and are not recomputed.`,
        inputSchema: z.object({ source: z.union([z.object({ pks: z.array(z.string()) }).strict(), aggregation]), where: z.union([where, metricWhere]) }).strict(),
      },
      guarded(async (args: { source: { pks: string[] } | AggregationResult<ObjectInstance, string>; where: Condition[] }, extra: { sessionId?: string }) => {
        const actor = actorOf(extra)
        if ('pks' in args.source) return asJson(rt.filter(hydrate(typeName, args.source.pks, actor), args.where as Where<any>))
        const source = args.source
        // Validate the incoming correspondence before applying session visibility.
        const checked = aggregationResult(source.set, source.columns, source.values)
        const set = hydrate(typeName, checked.set.objects.map((o) => o.pk), actor)
        const visible = new Set(set.objects.map((o) => o.pk))
        // A partially visible group cannot retain a metric computed for all its members.
        // Drop the whole row: its metric may come from other evidence (e.g.
        // transfers), so the remaining target objects cannot reconstruct it.
        const rows = checked.values.filter((row) => row.pks.every((pk) => visible.has(pk)))
        return asJson(rt.filter(aggregationResult(set, checked.columns, rows), args.where as MetricWhere<string>))
      }),
    )
    // Per-type tools make both ID lists use the same object identity namespace.
    for (const op of ['union', 'intersect', 'subtract'] as const) {
      server.registerTool(
        toolName(`${op}_${snake(typeName)}`, `${op} ${typeName}`),
        { description: `${op} two ${typeName} sets, identified by primary keys and reloaded for this session.`,
          inputSchema: z.object({ left: z.array(z.string()), right: z.array(z.string()) }).strict() },
        guarded(async (args: { left: string[]; right: string[] }, extra: { sessionId?: string }) =>
          asJson(rt[op](hydrate(typeName, args.left, actorOf(extra)), hydrate(typeName, args.right, actorOf(extra))))),
      )
    }
    // Reuse query's field classification so agent choices match local validation:
    // supported scalar properties for groups, numeric properties for sums.
    const propertyKeys = Object.entries(def.properties).filter(([, schema]) => fieldInfo(schema as z.ZodType)).map(([key]) => key) as [string, ...string[]]
    const numericKeys = Object.entries(def.properties).filter(([, schema]) => fieldInfo(schema as z.ZodType)?.kind === 'number').map(([key]) => key)
    const aggregateShape: Record<string, z.ZodType> = {
      pks: z.array(z.string()), group_by: z.enum(propertyKeys), where: where.optional(),
    }
    if (numericKeys.length > 0) aggregateShape.sum = z.enum(numericKeys as [string, ...string[]]).optional()
    server.registerTool(
      toolName(`aggregate_${snake(typeName)}`, `aggregate ${typeName}`),
      {
        description: `Group the selected ${typeName} objects by one property, count members and optionally sum a numeric property. Returns set, numeric columns, and values with member pks. Use filter_${snake(typeName)} to filter the result.`,
        inputSchema: z.object(aggregateShape).strict(),
      },
      guarded(async (rawArgs: Record<string, unknown>, extra: { sessionId?: string }) => {
        const args = rawArgs as { pks: string[]; group_by: string; sum?: string; where?: Condition[] }
        const source = hydrate(typeName, args.pks, actorOf(extra))
        const set = args.where === undefined ? source : rt.filter(source, args.where as Where<any>)
        return asJson(args.sum === undefined ? rt.aggregate(set, { groupBy: args.group_by })
          : rt.aggregate(set, { groupBy: args.group_by, sum: args.sum }))
      }),
    )
  }

  // A link's endpoints determine whether direction is required. With different
  // endpoint types, Runtime still checks an explicit direction against source.type.
  for (const [linkName, link] of Object.entries(rt.ontology.links)) {
    server.registerTool(
      toolName(`traverse_${snake(linkName)}`, `link type ${linkName}`),
      {
        description:
          `Traverse the ${link.from} → ${link.to} link "${linkName}" (${link.kind}). ` +
          'Pass an instance returned by get or search; its properties are a snapshot, not authority. ' +
          (link.from === link.to
            ? 'Choose direction=forward or reverse for this self-type link.'
            : 'Direction is inferred from source.type; an explicit direction must agree.'),
        inputSchema: {
          source: z.object({
            type: z.enum([link.from, link.to]),
            pk: z.string(),
            properties: z.record(z.string(), z.unknown()),
          }),
          direction: link.from === link.to
            ? z.enum(['forward', 'reverse'])
            : z.enum(['forward', 'reverse']).optional(),
        },
      },
      guarded(async (args: { source: ObjectInstance; direction?: 'forward' | 'reverse' }, extra: { sessionId?: string }) =>
        // Names are dynamic here. The runtime checks the instance, link, and
        // direction together; no permissive overload is needed by typed callers.
        asJson(rt.traverse(args.source, linkName, {
          actor: actorOf(extra), direction: args.direction,
        } as TraverseOptions<OntologyDef, string, string>))),
    )
  }

  for (const [linkName, link] of Object.entries(rt.ontology.links)) {
    server.registerTool(
      toolName(`pivot_${snake(linkName)}`, `pivot ${linkName}`),
      {
        description: `Follow ${linkName} from a set of ${link.from} or ${link.to}. Duplicate target identities are removed. Direction is required when both ends have the same type.`,
        inputSchema: {
          source: z.object({ type: z.enum([link.from, link.to]), pks: z.array(z.string()) }).strict(),
          direction: link.from === link.to ? z.enum(['forward', 'reverse']) : z.enum(['forward', 'reverse']).optional(),
        },
      },
      guarded(async (args: { source: { type: string; pks: string[] }; direction?: 'forward' | 'reverse' }, extra: { sessionId?: string }) => {
        const actor = actorOf(extra)
        return asJson(rt.pivot(hydrate(args.source.type, args.source.pks, actor), linkName,
          { actor, direction: args.direction } as TraverseOptions<OntologyDef, string, string>))
      }),
    )
  }

  // Invoke Actions through run, preserving the same validation, write-back and
  // audit path as local callers. A business refusal becomes an MCP tool error.
  for (const [actionName, action] of Object.entries(rt.ontology.actions)) {
    server.registerTool(
      toolName(snake(actionName), `action ${actionName}`),
      {
        description:
          `${action.description ?? `Action on ${action.object}.`} ` +
          'Writes are gated: if a business rule rejects this call, the error is ' +
          'machine-readable ({ code, message }) and the attempt is recorded in the audit log.',
        inputSchema: action.params,
      },
      guarded(async (params: Record<string, unknown>, extra: { sessionId?: string }) => {
        const result = rt.run(actionName, params, { actor: actorOf(extra) })
        if (!result.ok) {
          return { ...asJson({ error: result.error }), isError: true }
        }
        return asJson({ applied: result.edits })
      }),
    )
  }

  // Read-only is a Function authoring contract; the MCP hint advertises it.
  // Await supports both synchronous values and asynchronous Function results.
  for (const [name, fn] of Object.entries(rt.ontology.functions ?? {})) {
    server.registerTool(
      toolName(snake(name), `function ${name}`),
      {
        description: fn.description ?? `Read through the model's ${name} function.`,
        inputSchema: fn.params,
        annotations: { readOnlyHint: true },
      },
      guarded(async (params: Record<string, unknown>, extra: { sessionId?: string }) =>
        asJson(await rt.run(name, params, { actor: actorOf(extra) }))),
    )
  }

  server.registerTool(
    toolName('read_audit_log', 'the built-in audit view'),
    {
      description:
        'Read the append-only audit log: every applied and rejected action, with actor and params. ' +
        'This is an unscoped administrative view — entries are not filtered by visibility (fail-open, declared).',
      inputSchema: {
        action: z.string().optional(),
        status: z.enum(['applied', 'rejected']).optional(),
        target: z.string().optional(),
      },
    },
    guarded(async (filter: Record<string, unknown>) =>
      asJson(rt.auditLog(prune(filter) as Parameters<typeof rt.auditLog>[0]))),
  )

  return server
}

const snake = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

const prune = <T extends Record<string, unknown>>(obj: T): T =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T
