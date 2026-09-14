import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { z } from 'zod'
import {
  aggregationResult, createRuntime, defineLink, defineObject, defineOntology, objectSet,
  type AggregationResult, type AggregationRow, type ObjectOf, type ObjectSet, type Runtime,
} from '../src/index.js'
import { aggregate, combine, filterAggregation, filterObjects } from '../src/query.js'

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

test('local predicates select snapshots and keep the set tag, order and identity', (t) => {
  const rt = runtime(t)
  const input = rt.search('Lot', { actor: 'admin' })
  const selected = rt.filter(input, (lot) => lot.properties.family === 'A' && lot.properties.units >= 30)
  assert.deepEqual(ids(selected), ['L1', 'L2'])
  assert.equal(selected.type, 'Lot')
  assert.equal(selected.objects[0], input.objects[0], 'filter shares read snapshots')
  assert.deepEqual(ids(input), ['L1', 'L2', 'L3', 'L4'])
  assert.deepEqual(rt.filter(selected, () => false), { type: 'Lot', objects: [] })
  assert.throws(() => rt.filter(input, () => { throw new Error('bad predicate') }), /bad predicate/)
  const seen: string[] = []
  rt.search('Employee', { actor: 'alice', filter: (employee) => { seen.push(employee.pk); return true } })
  assert.deepEqual(seen, ['E1', 'E2'], 'search applies visibility before the predicate')
  assert.deepEqual(rt.auditLog(), [])
})

test('predicates define date and missing-value semantics; serialized conditions are not accepted', () => {
  const dates = objectSet('Lot', [lot('before', 'A', 1, '2026-09-05T23:59:59+09:00'),
    lot('inside', 'A', 1, '2026-09-06T00:00:00Z'), lot('after', 'A', 1, '2026-09-07T00:00:00+09:00')])
  const selected = filterObjects(dates, (lot) => {
    const time = Date.parse(lot.properties.producedAt)
    return time >= Date.parse('2026-09-06T00:00:00+09:00') && time < Date.parse('2026-09-07T00:00:00+09:00')
  })
  assert.deepEqual(ids(selected), ['inside'])
  const nullable = objectSet('Value', [
    { type: 'Value', pk: 'missing', properties: { amount: null } },
    { type: 'Value', pk: 'present', properties: { amount: 5 } },
  ])
  assert.deepEqual(ids(filterObjects(nullable, (value) => value.properties.amount === null)), ['missing'])
  for (const input of [lots(), objectSet('Lot', [] as Lot[])]) {
    for (const invalid of [{ quality: 'suspect' }, [{ property: 'units', op: 'gte', value: 30 }], 'object => true']) {
      assert.throws(() => filterObjects(input, invalid as never), /predicate function/)
    }
  }
})

test('filtering aggregate rows keeps the corresponding members and does not recompute metrics', (t) => {
  const rt = runtime(t)
  const input = rt.search('Lot', { actor: 'admin' })
  const grouped = rt.aggregate(input, { groupBy: 'family', sum: 'units' })
  assert.deepEqual(grouped.values, [
    { key: 'A', pks: ['L1', 'L2', 'L3'], metrics: { count: 3, sum: 90 } },
    { key: 'B', pks: ['L4'], metrics: { count: 1, sum: 50 } },
  ])
  const selected = rt.filter(grouped, (row) => row.metrics.count >= 2 && row.metrics.sum >= 80)
  assert.deepEqual(ids(selected.set), ['L1', 'L2', 'L3'])
  assert.equal(selected.values[0].metrics.sum, 90)
  const larger = rt.filter(selected.set, (lot) => lot.properties.units >= 30)
  assert.deepEqual(ids(larger), ['L1', 'L2'])
  assert.equal(selected.values[0].metrics.sum, 90)
  assert.equal(rt.aggregate(larger, { groupBy: 'family', sum: 'units' }).values[0].metrics.sum, 70)
  const none = rt.filter(selected, (row) => row.metrics.count > 3)
  assert.deepEqual(none, { set: { type: 'Lot', objects: [] }, values: [] })
  assert.deepEqual(rt.auditLog(), [])
})

test('custom Function metrics use the same aggregation contract', () => {
  const set = lots()
  const result = aggregationResult(set, [
    { key: 'X', pks: ['L1', 'L2'], metrics: { senderCount: 3, totalAmount: 5100000 } },
    { key: 'Y', pks: ['L3'], metrics: { senderCount: 1, totalAmount: 100000 } },
  ])
  const selected = filterAggregation(result, (row) => row.metrics.senderCount >= 2)
  assert.deepEqual(ids(selected.set), ['L1', 'L2'])
  assert.equal(selected.values[0].metrics.totalAmount, 5100000)
  assert.throws(() => aggregationResult(set, [{ key: 'A', pks: ['missing'], metrics: { count: 1 } }]), /unknown object/)
  assert.throws(() => aggregationResult(set, [{ key: 'A', pks: ['L1'], metrics: { count: NaN } }]), /invalid metric/)
  assert.throws(() => filterAggregation(result, [] as never), /predicate function/)
  assert.deepEqual(aggregate(objectSet('Lot', [] as Lot[]), { groupBy: 'family' }, fields),
    { set: { type: 'Lot', objects: [] }, values: [] })
})

test('aggregation keeps identity separate from metrics without requiring a column schema', () => {
  const set = lots()
  const metrics = { key: 1, pks: 2 }
  const rows: AggregationRow[] = [
    { key: 'A', pks: ['L1', 'L1'], metrics },
    { key: 'B', pks: ['L1', 'L2'], metrics: { sum: 30 } },
  ]
  const result = aggregationResult(set, rows)
  assert.deepEqual(ids(result.set), ['L1', 'L2'], 'overlapping groups still have a unique target set')
  assert.deepEqual(result.values[0], { key: 'A', pks: ['L1'], metrics: { key: 1, pks: 2 } })
  metrics.key = 99
  assert.equal(result.values[0].metrics.key, 1, 'result metrics are copied')
  assert.deepEqual(ids(filterAggregation(result, (row) => row.key === 'B').set), ['L1', 'L2'])
  assert.throws(() => aggregationResult(set, [rows[0], rows[0]]), /duplicate aggregation group/)
  assert.throws(() => aggregationResult(set, [{ key: 'A', pks: [], metrics: {} }]), /invalid.*group/)
  for (const metrics of [null, [], { count: NaN }, { count: Infinity }, { count: 'two' }]) {
    assert.throws(() => aggregationResult(set, [{ key: 'A', pks: ['L1'], metrics: metrics as never }]), /invalid metric/)
  }
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
  // @ts-expect-error filter accepts only a predicate
  rt.filter(input, { quality: 'suspect' })
  // @ts-expect-error serialized conditions are no longer supported
  rt.filter(input, [{ property: 'units', op: 'approximately', value: 40 }])
  const custom = aggregationResult(input, [{ key: 'X', pks: ['L1'], metrics: { senderCount: 3 } }])
  const selected: AggregationResult<Lot> = rt.filter(custom, (row) => row.metrics.senderCount >= 2)
  const exact: ObjectSet<Lot> = selected.set
  // @ts-expect-error metrics are numeric
  aggregationResult(input, [{ key: 'X', pks: ['L1'], metrics: { count: 'three' } }])
  // @ts-expect-error metric snapshots are readonly
  selected.values[0].metrics.senderCount = 4
  // These are accepted by TypeScript and rejected by the runtime tests below.
  rt.union(input, equipment)
  objectSet('Equipment', input.objects)
  // @ts-expect-error predicates must be synchronous
  rt.filter(input, async () => true)
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
  assert.throws(() => rt.aggregate(empty, { groupBy: 'unknown' }), /invalid groupBy/)
  assert.throws(() => rt.aggregate(input, { groupBy: 'family', sum: 'quality' }), /sum requires a numeric property/)
  const grouped = rt.aggregate(input, { groupBy: 'family' })
  assert.deepEqual(ids(rt.filter(grouped, (row) => row.metrics.count >= 2).set), ['L1', 'L2', 'L3'])
  assert.deepEqual(rt.auditLog(), [], 'query errors never perform writes or audit actions')
})
