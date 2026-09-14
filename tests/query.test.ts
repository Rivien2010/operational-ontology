import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { z } from 'zod'
import {
  aggregationResult, createRuntime, defineLink, defineObject, defineOntology, objectSet,
  type AggregationResult, type ObjectOf, type ObjectSet, type Runtime,
} from '../src/index.js'
import { aggregate, combine, filterAggregation, filterObjects, whereSchema } from '../src/query.js'

const fields = {
  id: z.string(), family: z.string(), units: z.number(), quality: z.enum(['good', 'suspect']),
  producedAt: z.iso.datetime({ offset: true }), released: z.boolean(),
}
const model = defineOntology({
  name: 'sets',
  objects: {
    Lot: defineObject({ primaryKey: 'id', properties: fields }),
    Equipment: defineObject({ primaryKey: 'id', properties: { id: z.string() } }),
    Employee: defineObject({ primaryKey: 'id', properties: { id: z.string(), owner: z.string() },
      visibility: ({ object, actor }) => actor === 'admin' || object.properties.owner === actor }),
  },
  links: {
    producedOn: defineLink({ from: 'Equipment', to: 'Lot', kind: 'many-to-many' }),
    manages: defineLink({ from: 'Employee', to: 'Employee', kind: 'one-to-many' }),
  },
  actions: {},
})
type Model = typeof model
type Lot = ObjectOf<Model, 'Lot'>
const lot = (id: string, family: string, units: number, producedAt = '2026-09-06T09:00:00+09:00'): Lot => ({
  type: 'Lot', pk: id, properties: { id, family, units, producedAt, quality: 'suspect', released: true },
})
const lots = () => objectSet('Lot', [lot('L1', 'A', 40), lot('L2', 'A', 30), lot('L3', 'A', 20), lot('L4', 'B', 50)])
const ids = (set: ObjectSet) => set.objects.map((o) => o.pk)
function runtime(t: TestContext) {
  const db = new Database(':memory:')
  t.after(() => db.close())
  const rt = createRuntime(model, db)
  rt.load({ objects: {
    Lot: lots().objects.map((o) => o.properties), Equipment: [{ id: 'P1' }, { id: 'P2' }],
    Employee: [{ id: 'E1', owner: 'alice' }, { id: 'E2', owner: 'alice' }, { id: 'E3', owner: 'bob' }],
  }, links: { producedOn: [['P1', 'L1'], ['P1', 'L2'], ['P2', 'L1']], manages: [['E1', 'E2'], ['E2', 'E3']] } })
  return rt
}

test('set identity, empty tags and stable algebra require no database', () => {
  const a = objectSet('Lot', [lot('L2', 'A', 30), lot('L1', 'A', 40), lot('L2', 'A', 999)])
  const b = objectSet('Lot', [lot('L1', 'A', 777), lot('L3', 'A', 20)])
  assert.deepEqual(ids(a), ['L2', 'L1'])
  assert.deepEqual(ids(combine('union', a, b)), ['L2', 'L1', 'L3'])
  assert.equal(combine('union', a, b).objects[1].properties.units, 40, 'left snapshot wins')
  assert.deepEqual(ids(combine('intersect', a, b)), ['L1'])
  assert.deepEqual(ids(combine('subtract', a, b)), ['L2'])
  assert.deepEqual(combine('subtract', a, a), { type: 'Lot', objects: [] })
  const other = objectSet('Equipment', [{ type: 'Equipment', pk: 'L1', properties: { id: 'L1' } }])
  assert.throws(() => combine('union', a, other), /same object type/)
  assert.throws(() => objectSet('Lot', other.objects), /differently tagged/)
  assert.deepEqual(ids(a), ['L2', 'L1'], 'inputs were not changed')
})

test('structured filters use AND, exact case, typed values and instant comparisons', () => {
  const input = lots()
  assert.deepEqual(ids(filterObjects(input, [
    { property: 'family', op: 'eq', value: 'A' }, { property: 'units', op: 'gte', value: 30 },
  ], fields)), ['L1', 'L2'])
  assert.deepEqual(ids(filterObjects(input, [{ property: 'family', op: 'contains', value: 'a' }], fields)), [])
  for (const [op, value, expected] of [
    ['ne', 'A', ['L4']], ['in', ['A'], ['L1', 'L2', 'L3']], ['contains', 'A', ['L1', 'L2', 'L3']],
  ] as const) assert.deepEqual(ids(filterObjects(input, [{ property: 'family', op, value }], fields)), expected)
  for (const [op, expected] of [['gt', ['L1', 'L4']], ['gte', ['L1', 'L2', 'L4']],
    ['lt', ['L3']], ['lte', ['L2', 'L3']]] as const) {
    assert.deepEqual(ids(filterObjects(input, [{ property: 'units', op, value: 30 }], fields)), expected)
  }
  assert.equal(filterObjects(input, [{ property: 'released', op: 'eq', value: true }], fields).objects.length, 4)
  assert.deepEqual(filterObjects(input, [{ property: 'producedAt', op: 'eq', value: '2026-09-06T00:00:00Z' }], fields), input)
  const dates = objectSet('Lot', [lot('before', 'A', 1, '2026-09-05T23:59:59+09:00'),
    lot('inside', 'A', 1), lot('after', 'A', 1, '2026-09-07T00:00:00+09:00')])
  assert.deepEqual(ids(filterObjects(dates, [
    { property: 'producedAt', op: 'gte', value: '2026-09-06T00:00:00+09:00' },
    { property: 'producedAt', op: 'lt', value: '2026-09-07T00:00:00+09:00' },
  ], fields)), ['inside'])
  assert.deepEqual(ids(filterObjects(input, (o: Lot) => o.properties.units === 20, fields)), ['L3'])
  const day = objectSet('Day', [{ type: 'Day', pk: 'D1', properties: { on: '2026-09-06' } }])
  assert.deepEqual(filterObjects(day, [{ property: 'on', op: 'gte', value: '2026-09-06' }], { on: z.iso.date() }), day)
  assert.deepEqual(filterObjects(day, [{ property: 'on', op: 'lt', value: '2026-09-06' }], { on: z.iso.date() }).objects, [])
})

test('invalid conditions fail on empty sets too; null and coercion are not query features', () => {
  const empty = objectSet('Lot', [] as Lot[])
  for (const where of [
    { quality: 'suspect' }, [{ property: 'missing', op: 'eq', value: 1 }],
    [{ property: 'quality', op: 'eq', value: 'lost' }], [{ property: 'units', op: 'gte', value: '30' }],
    [{ property: 'units', op: 'contains', value: '3' }], [{ property: 'family', op: 'gte', value: 'A' }],
    [{ property: 'released', op: 'gt', value: false }], [{ property: 'quality', op: 'isNull' }],
    [{ property: 'producedAt', op: 'gte', value: 'September 6' }],
  ]) assert.throws(() => filterObjects(empty, where, fields))
  assert.equal(whereSchema(fields).safeParse([{ property: 'units', op: 'in', value: [20, 30] }]).success, true)
  const broken = lots()
  ;(broken.objects[0].properties as Record<string, unknown>).units = '40'
  assert.throws(() => filterObjects(broken, [{ property: 'units', op: 'gt', value: 30 }], fields), /value type/)
  ;(broken.objects[0].properties as Record<string, unknown>).units = null
  assert.throws(() => filterObjects(broken, [{ property: 'units', op: 'eq', value: 30 }], fields), /null, missing/)
})

test('filtering aggregate rows keeps the corresponding members and does not recompute metrics', (t) => {
  const rt = runtime(t)
  const input = rt.search('Lot', { actor: 'admin' })
  const grouped = rt.aggregate(input, { groupBy: 'family', sum: 'units' })
  assert.deepEqual(grouped.columns, { count: 'number', sum: 'number' })
  assert.deepEqual(grouped.values, [
    { key: 'A', pks: ['L1', 'L2', 'L3'], count: 3, sum: 90 },
    { key: 'B', pks: ['L4'], count: 1, sum: 50 },
  ])
  const selected = rt.filter(grouped, [{ property: 'count', op: 'gte', value: 2 }, { property: 'sum', op: 'gte', value: 80 }])
  assert.deepEqual(ids(selected.set), ['L1', 'L2', 'L3'])
  assert.equal(selected.values[0].sum, 90)
  const larger = rt.filter(selected.set, [{ property: 'units', op: 'gte', value: 30 }])
  assert.deepEqual(ids(larger), ['L1', 'L2'])
  assert.equal(selected.values[0].sum, 90)
  assert.equal(rt.aggregate(larger, { groupBy: 'family', sum: 'units' }).values[0].sum, 70)
  const none = rt.filter(selected, [{ property: 'count', op: 'gt', value: 3 }])
  assert.deepEqual(none, { set: { type: 'Lot', objects: [] }, columns: { count: 'number', sum: 'number' }, values: [] })
  assert.deepEqual(rt.auditLog(), [])
})

test('custom Function metrics use the same aggregation contract', () => {
  const set = lots()
  const result = aggregationResult(set, { senderCount: 'number', totalAmount: 'number' }, [
    { key: 'X', pks: ['L1', 'L2'], senderCount: 3, totalAmount: 5100000 },
    { key: 'Y', pks: ['L3'], senderCount: 1, totalAmount: 100000 },
  ])
  const selected = filterAggregation(result, [{ property: 'senderCount', op: 'gte', value: 2 }])
  assert.deepEqual(ids(selected.set), ['L1', 'L2'])
  assert.equal(selected.values[0].totalAmount, 5100000)
  assert.throws(() => aggregationResult(set, { count: 'number' }, [{ key: 'A', pks: ['missing'], count: 1 }]), /unknown object/)
  assert.throws(() => aggregationResult(set, { count: 'number' }, [{ key: 'A', pks: ['L1'], count: NaN }]), /invalid metric/)
  assert.throws(() => filterAggregation(result, [{ property: 'count', op: 'gte', value: 2 }]))
  assert.deepEqual(aggregate(objectSet('Lot', [] as Lot[]), { groupBy: 'family' }, fields),
    { set: { type: 'Lot', objects: [] }, columns: { count: 'number' }, values: [] })
})

test('pivot deduplicates, preserves empty target tags and rechecks visibility and direction', (t) => {
  const rt = runtime(t)
  assert.deepEqual(ids(rt.pivot(rt.search('Equipment', { actor: 'admin' }), 'producedOn', { actor: 'admin' })), ['L1', 'L2'])
  const empty = rt.filter(rt.search('Equipment', { actor: 'admin' }), () => false)
  assert.deepEqual(rt.pivot(empty, 'producedOn', { actor: 'admin' }), { type: 'Lot', objects: [] })
  const employees = rt.search('Employee', { actor: 'admin' })
  const alice = rt.pivot(employees, 'manages', { actor: 'alice', direction: 'forward' })
  assert.deepEqual(ids(alice), ['E2'])
  const forged = objectSet('Employee', [{ ...employees.objects[2], properties: { id: 'E3', owner: 'alice' } }])
  assert.deepEqual(ids(rt.pivot(forged, 'manages', { actor: 'alice', direction: 'reverse' })), [])
  assert.throws(() => rt.pivot(objectSet('Employee', []), 'manages', { actor: 'admin' }), /requires a direction/)
  assert.throws(() => rt.pivot(empty, 'producedOn', { actor: 'admin', direction: 'reverse' }), /invalid direction/)
  assert.deepEqual(ids(rt.union(alice, employees)), ['E2', 'E1', 'E3'])
  assert.deepEqual(ids(rt.intersect(employees, alice)), ['E2'])
  assert.deepEqual(ids(rt.subtract(employees, alice)), ['E1', 'E3'])
})

/** Fixed data shapes stay typed; schema-specific combinations are runtime checks. */
export function compileOnly(rt: Runtime<Model>) {
  const input = rt.search('Lot', { actor: 'admin' })
  const equipment = rt.search('Equipment', { actor: 'admin' })
  // @ts-expect-error arrays are readonly
  input.objects.push(input.objects[0])
  // @ts-expect-error tags are readonly
  input.type = 'Lot'
  // @ts-expect-error conditions still require the explicit clause array
  rt.filter(input, { quality: 'suspect' })
  // @ts-expect-error operation vocabulary is fixed, even without property-specific hints
  rt.filter(input, [{ property: 'units', op: 'approximately', value: 40 }])
  const custom = aggregationResult(input, { senderCount: 'number' }, [{ key: 'X', pks: ['L1'], senderCount: 3 }])
  const selected: AggregationResult<Lot> = rt.filter(custom, [{ property: 'senderCount', op: 'gte', value: 2 }])
  const exact: ObjectSet<Lot> = selected.set
  // These are accepted by TypeScript and rejected by the runtime tests below.
  rt.union(input, equipment)
  objectSet('Equipment', input.objects)
  rt.filter(input, [{ property: 'units', op: 'gt', value: '40' }])
  rt.aggregate(input, { groupBy: 'family', sum: 'quality' })
  void exact
}

test('public APIs reject model-specific mistakes without TypeScript navigation constraints', (t) => {
  const rt = runtime(t)
  const input = rt.search('Lot', { actor: 'admin' })
  const equipment = rt.search('Equipment', { actor: 'admin' })
  for (const operation of ['union', 'intersect', 'subtract'] as const) {
    assert.throws(() => rt[operation](input, equipment), /same object type/)
  }
  assert.throws(() => objectSet('Equipment', input.objects), /differently tagged/)
  const empty = rt.filter(input, () => false)
  for (const where of [
    [{ property: 'units', op: 'gt', value: '40' }],
    [{ property: 'family', op: 'gt', value: 'A' }],
    [{ property: 'producedAt', op: 'contains', value: '2026' }],
    [{ property: 'quality', op: 'eq', value: 'lost' }],
  ] as const) assert.throws(() => rt.filter(empty, where), z.ZodError)
  assert.throws(() => rt.aggregate(empty, { groupBy: 'unknown' }), /invalid groupBy/)
  assert.throws(() => rt.aggregate(input, { groupBy: 'family', sum: 'quality' }), /sum requires a numeric property/)
  const grouped = rt.aggregate(input, { groupBy: 'family' })
  assert.throws(() => rt.filter(grouped, [{ property: 'sum', op: 'gt', value: 0 }]), z.ZodError)
  assert.deepEqual(ids(rt.filter(grouped, (row) => typeof row.count === 'number' && row.count >= 2).set), ['L1', 'L2', 'L3'])
  assert.deepEqual(rt.auditLog(), [], 'query errors never perform writes or audit actions')
})
