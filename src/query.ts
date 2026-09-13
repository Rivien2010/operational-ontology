/**
 * Evaluated sets and aggregations. These operations never read or write a store.
 * Types describe valid combinations first; the functions below validate and
 * evaluate them. Runtime reads supply actor-visible snapshots; these helpers
 * also accept caller-constructed values.
 * Filtering an existing snapshot does not refresh it or recheck visibility.
 */
import { z } from 'zod'
import type { ObjectInstance, Properties } from './model.js'

/**
 * Pair each tag with its objects before forming a union. Empty sets keep their tag.
 * Extract selects only instances of K: ObjectSet<Lot | Equipment> is a choice
 * between two homogeneous sets, not one array mixing both kinds of object.
 */
export type ObjectSet<O extends ObjectInstance = ObjectInstance> = {
  [K in O['type']]: { readonly type: K; readonly objects: readonly Extract<O, { type: K }>[] }
}[O['type']]

type Scalar = string | number | boolean
type Comparison<V> = { op: 'eq' | 'ne'; value: V } | { op: 'in'; value: readonly V[] }
type Ordered<V> = { op: 'gt' | 'gte' | 'lt' | 'lte'; value: V }
// Wrappers preserve a field's query operators, but do not introduce comparisons
// with null or missing values. Those cases are outside this query contract.
type Unwrap<S> = S extends z.ZodOptional<infer I> | z.ZodNullable<infer I> | z.ZodDefault<infer I> ? Unwrap<I> : S
type QuerySchema = z.ZodString | z.ZodEnum<any> | z.ZodNumber | z.ZodBoolean | z.ZodLiteral | z.ZodISODateTime | z.ZodISODate
// [V] checks the union as a whole instead of each alternative separately.
// An enum's `in` can therefore contain several of its allowed string values.
type ScalarOperators<V> = [V] extends [never] ? never
  : [V] extends [number] ? Comparison<number> | Ordered<number>
  : [V] extends [string] ? Comparison<V> | { op: 'contains'; value: string }
  : [V] extends [boolean] ? Comparison<boolean> : never
// ISO dates are strings in TypeScript. Keep the Zod schema here so only date
// schemas, rather than arbitrary strings, also offer ordered comparisons.
type Operators<S> = S extends z.ZodType ? Unwrap<S> extends QuerySchema
  ? Unwrap<S> extends z.ZodISODateTime | z.ZodISODate ? Comparison<string> | Ordered<string>
    : ScalarOperators<Exclude<z.output<S>, null | undefined>>
  : never : never

/** Each union member pairs one property with its own operators and value type. */
export type Where<S extends Properties> = readonly {
  [K in keyof S & string]: { property: K } & Operators<S[K]>
}[keyof S & string][]
// Local code may use a synchronous, pure callback; MCP accepts serializable clauses.
export type ObjectFilter<O extends ObjectInstance, S extends Properties = Properties> =
  Where<S> | ((object: O) => boolean)
export type MetricWhere<C extends string> = readonly ({ property: C } & (Comparison<number> | Ordered<number>))[]

/**
 * `set` holds the target objects; each row's `pks` associates metrics with members
 * of that set. `key` labels the group and need not be an object's primary key.
 * Columns are runtime data too, so MCP can inspect custom Function metrics.
 * For metrics derived from other objects (e.g. transfers for an account), a
 * Function returns that evidence separately; pks here still identify set members.
 */
export interface AggregationResult<O extends ObjectInstance = ObjectInstance, C extends string = never> {
  readonly set: ObjectSet<O>
  readonly columns: Readonly<Record<C, 'number'>>
  readonly values: readonly ({ readonly key: Scalar; readonly pks: readonly string[] } & Readonly<Record<C, number>>)[]
}

// Keep supported scalar fields for grouping, then only numeric fields for sums.
// Mapping unsupported fields to never removes them from the editor's candidates.
export type GroupProperty<S extends Properties> = {
  [K in keyof S & string]: [Operators<S[K]>] extends [never] ? never : K
}[keyof S & string]
export type SumProperty<S extends Properties> = {
  [K in GroupProperty<S>]: Exclude<z.output<S[K]>, null | undefined> extends number ? K : never
}[GroupProperty<S>]

/** Broad internal shape; whereSchema checks the actual property/operator/value pairing. */
export interface Condition { property: string; op: 'eq' | 'ne' | 'in' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte'; value: unknown }
const own = (value: object, key: string) => Object.hasOwn(value, key)
const scalar = (v: unknown): v is Scalar => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))

/**
 * A small constructor also used by model Functions. First occurrence wins.
 * NoInfer makes objects follow the supplied tag instead of widening it to fit.
 * The direct return shape retains K even for an empty array inferred as never[].
 * This checks instance shape and identity, not the business property schema.
 * It creates a new array, sharing the snapshots rather than deeply copying them.
 */
export function objectSet<K extends string, O extends ObjectInstance<NoInfer<K>>>(
  type: K, objects: readonly O[],
): { readonly type: K; readonly objects: readonly O[] } {
  if (typeof type !== 'string' || !Array.isArray(objects)) throw new Error('invalid object set')
  const unique = new Map<string, O>()
  for (const object of objects) {
    if (!object || object.type !== type || typeof object.pk !== 'string' ||
        !object.properties || typeof object.properties !== 'object' || Array.isArray(object.properties)) {
      throw new Error(`object set ${type} contains an invalid or differently tagged object`)
    }
    // After checking the common tag, pk alone is enough to deduplicate identity.
    if (!unique.has(object.pk)) unique.set(object.pk, object)
  }
  return { type, objects: [...unique.values()] }
}

/** Same-type identity operations; preserve left-hand order and snapshots when IDs overlap. */
export function combine<O extends ObjectInstance>(op: 'union' | 'intersect' | 'subtract', a: ObjectSet<O>, b: ObjectSet<O>): ObjectSet<O> {
  if (a.type !== b.type) throw new Error('set operations require the same object type')
  const left = objectSet(a.type, a.objects)
  const right = objectSet(b.type, b.objects)
  const ids = new Set(right.objects.map((o) => o.pk))
  return objectSet(a.type, op === 'union' ? [...left.objects, ...right.objects]
    : left.objects.filter((o) => op === 'intersect' ? ids.has(o.pk) : !ids.has(o.pk))) as ObjectSet<O>
}

/**
 * Runtime counterpart of Operators: keep both aligned when adding a field kind.
 * Query values need not satisfy every stored-value constraint: a nonnegative
 * amount can still be compared with -1. String enums retain their choice hints.
 */
export function fieldInfo(schema: z.core.$ZodType) {
  let inner = schema as z.ZodType
  while (inner instanceof z.ZodOptional || inner instanceof z.ZodNullable || inner instanceof z.ZodDefault) inner = inner.unwrap() as z.ZodType
  if (inner instanceof z.ZodString || inner instanceof z.ZodISODateTime || inner instanceof z.ZodISODate) {
    const format = inner.format
    if (format === 'datetime' || format === 'date') return {
      kind: 'datetime' as const,
      value: format === 'date' ? z.iso.date() : z.iso.datetime({ offset: true }),
    }
    return { kind: 'string' as const, value: z.string() }
  }
  if (inner instanceof z.ZodEnum) {
    if (inner.options.every((v) => typeof v === 'number')) return { kind: 'number' as const, value: z.number() }
    if (inner.options.every((v) => typeof v === 'string')) return { kind: 'string' as const, value: inner }
  }
  if (inner instanceof z.ZodLiteral) {
    const values = [...inner.values]
    if (values.every((v) => typeof v === 'string')) return { kind: 'string' as const, value: inner }
    if (values.every((v) => typeof v === 'number')) return { kind: 'number' as const, value: z.number() }
    if (values.every((v) => typeof v === 'boolean')) return { kind: 'boolean' as const, value: z.boolean() }
  }
  if (inner instanceof z.ZodNumber) return { kind: 'number' as const, value: z.number() }
  if (inner instanceof z.ZodBoolean) return { kind: 'boolean' as const, value: z.boolean() }
  return undefined
}

function operations(kind: NonNullable<ReturnType<typeof fieldInfo>>['kind']): Condition['op'][] {
  return ['eq', 'ne', 'in', ...(kind === 'string' ? ['contains' as const] : []),
    ...(kind === 'number' || kind === 'datetime' ? ['gt', 'gte', 'lt', 'lte'] as const : [])]
}

/** The same field/operator definitions drive MCP schemas and local validation. */
export function whereSchema(properties: Properties): z.ZodType<Condition[]> {
  const clauses: z.ZodType[] = []
  for (const [property, schema] of Object.entries(properties)) {
    const info = fieldInfo(schema)
    if (!info) continue
    for (const op of operations(info.kind)) {
      // Build complete clause alternatives: independent property/op/value enums
      // would also admit invalid combinations such as contains on a number.
      clauses.push(z.object({ property: z.literal(property), op: z.literal(op),
        value: op === 'in' ? z.array(info.value) : op === 'contains' ? z.string() : info.value }).strict())
    }
  }
  // Each supported field adds at least eq/ne/in, satisfying Zod's union arity.
  // With no supported fields, only an empty condition array is accepted.
  return z.array(clauses.length ? z.union(clauses as [z.ZodType, z.ZodType, ...z.ZodType[]]) : z.never()) as z.ZodType<Condition[]>
}

/** Clauses are ANDed; no implicit value coercion or case folding is performed. */
export function predicate(properties: Properties, where: unknown): (properties: Record<string, unknown>) => boolean {
  const conditions = whereSchema(properties).parse(where) // Validate even an empty input set.
  return (values) => conditions.every(({ property, op, value }) => {
    const info = fieldInfo(properties[property])!
    const raw = values[property]
    if (!scalar(raw)) throw new Error(`cannot compare null, missing or non-scalar property ${property}`)
    if (info.kind !== 'datetime' && typeof raw !== info.kind) throw new Error(`invalid value type for ${property}`)
    // Compare instants, not ISO text: differing offsets can describe the same
    // instant. Date-only values are interpreted as UTC midnight by Date.parse.
    const normalize = (v: unknown): Scalar => {
      if (info.kind !== 'datetime') return v as Scalar
      const parsed = info.value.parse(v)
      return Date.parse(parsed as string)
    }
    const actual = normalize(raw)
    if (op === 'in') return (value as unknown[]).some((item) => actual === normalize(item))
    const expected = normalize(value)
    switch (op) {
      case 'eq': return actual === expected
      case 'ne': return actual !== expected
      case 'contains': return typeof actual === 'string' && actual.includes(expected as string)
      case 'gt': return actual > expected
      case 'gte': return actual >= expected
      case 'lt': return actual < expected
      case 'lte': return actual <= expected
    }
  })
}

export function filterObjects<O extends ObjectInstance>(set: ObjectSet<O>, where: unknown, properties: Properties): ObjectSet<O> {
  const input = objectSet(set.type, set.objects)
  const matches = typeof where === 'function' ? where as (o: O) => boolean
    : ((test) => (o: O) => test(o.properties))(predicate(properties, where))
  return objectSet(set.type, input.objects.filter(matches)) as ObjectSet<O>
}

/**
 * Attach metrics to a set without putting derived values in business properties.
 * Validate declared columns and group membership, then retain only referenced
 * objects. Groups may overlap; their combined target set still has unique IDs.
 * NoInfer prevents row values from inventing columns absent from `columns`.
 */
export function aggregationResult<O extends ObjectInstance, C extends string>(
  set: ObjectSet<O>, columns: Readonly<Record<C, 'number'>>,
  values: AggregationResult<O, NoInfer<C>>['values'],
): AggregationResult<O, C> {
  const input = objectSet(set.type, set.objects)
  const known = new Set(input.objects.map((o) => o.pk))
  const included = new Set<string>()
  const keys = new Set<Scalar>()
  for (const [column, kind] of Object.entries(columns)) {
    if (kind !== 'number' || ['key', 'pks', '__proto__', 'constructor', 'prototype'].includes(column)) {
      throw new Error(`invalid metric column ${column}`)
    }
  }
  const rows = values.map((row) => {
    if (!scalar(row.key) || keys.has(row.key) || !Array.isArray(row.pks) || row.pks.length === 0) {
      throw new Error('invalid or duplicate aggregation group')
    }
    keys.add(row.key)
    const pks = [...new Set(row.pks)]
    for (const pk of pks) {
      if (!known.has(pk)) throw new Error(`aggregation refers to unknown object ${pk}`)
      included.add(pk)
    }
    for (const column of Object.keys(columns)) {
      const value = (row as Record<string, unknown>)[column]
      if (!own(row, column) || typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`invalid metric ${column}`)
    }
    if (Object.keys(row).some((key) => key !== 'key' && key !== 'pks' && !own(columns, key))) throw new Error('undeclared metric column')
    return { ...row, pks }
  })
  return { set: objectSet(set.type, input.objects.filter((o) => included.has(o.pk))) as ObjectSet<O>, columns: { ...columns }, values: rows }
}

/**
 * Select metric rows and their associated objects together. Retained metrics
 * are unchanged; filtering .set by object properties and aggregating again is
 * a separate operation when a newly calculated total is wanted.
 */
export function filterAggregation<O extends ObjectInstance, C extends string>(
  input: AggregationResult<O, C>, where: MetricWhere<NoInfer<C>> | ((row: Readonly<Record<C, number>>) => boolean),
): AggregationResult<O, C> {
  const result = aggregationResult(input.set, input.columns, input.values)
  const test = typeof where === 'function' ? where : predicate(
    Object.fromEntries(Object.keys(result.columns).map((column) => [column, z.number()])), where,
  )
  return aggregationResult(result.set, result.columns, result.values.filter(test))
}

/** Group existing snapshots by one property, retaining each group's members. */
export function aggregate<O extends ObjectInstance>(
  set: ObjectSet<O>, options: { groupBy: string; sum?: string }, properties: Properties,
): AggregationResult<O, 'count' | 'sum'> | AggregationResult<O, 'count'> {
  if (!own(properties, options.groupBy) || !fieldInfo(properties[options.groupBy])) throw new Error('invalid groupBy property')
  if (options.sum !== undefined && (!own(properties, options.sum) || fieldInfo(properties[options.sum])?.kind !== 'number')) {
    throw new Error('sum requires a numeric property')
  }
  const input = objectSet(set.type, set.objects)
  // Count unique objects, not paths that reached them. Sum also uses this object
  // grain: aggregate transfers before pivoting to deduplicated recipient accounts.
  const groups = new Map<Scalar, { key: Scalar; pks: string[]; count: number; sum?: number }>()
  for (const object of input.objects) {
    const key = object.properties[options.groupBy]
    if (!scalar(key)) throw new Error('groupBy requires a non-null scalar value')
    const row = groups.get(key) ?? { key, pks: [], count: 0, ...(options.sum !== undefined ? { sum: 0 } : {}) }
    row.pks.push(object.pk)
    row.count++
    if (options.sum !== undefined) {
      const amount = object.properties[options.sum]
      if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new Error('sum requires a non-null finite number')
      row.sum! += amount
    }
    groups.set(key, row)
  }
  const values = [...groups.values()]
  // The loop creates sum on every row exactly when requested. The assertion
  // expresses that relationship, which the optional field alone cannot convey.
  return options.sum === undefined ? aggregationResult(input, { count: 'number' }, values)
    : aggregationResult(input, { count: 'number', sum: 'number' }, values as AggregationResult<O, 'count' | 'sum'>['values'])
}
