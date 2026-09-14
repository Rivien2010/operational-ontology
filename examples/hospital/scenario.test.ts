import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHospital } from './runtime.js'
import { integrate } from './integrate.js'

const actor = 'user:planner'
const plan = { patientId: 'P1', bedId: 'B101', nurseId: 'N1', allocationId: 'PLAN1', note: 'Confirm reception arrangements' }
const ids = (objects: readonly { pk: string }[]) => objects.map((o) => o.pk)
function setup(t: TestContext) {
  const app = createHospital()
  t.after(() => app.close())
  return app
}

test('hospital pivots back only to confirmed waiting patients; candidate functions explain exclusions without writes', (t) => {
  const { rt } = setup(t)
  const all = rt.pivot(rt.search('Hospital', { actor }), 'hospitalPatients', { actor })
  const waiting = rt.filter(all, [{ property: 'status', op: 'eq', value: 'waiting' }])
  assert.deepEqual(ids(waiting.objects), ['P1', 'P2', 'P4'])
  const confirmed = rt.filter(rt.pivot(waiting, 'patientAdmission', { actor }), [{ property: 'confirmation', op: 'eq', value: 'approved' }])
  assert.deepEqual(ids(rt.pivot(confirmed, 'patientAdmission', { actor }).objects), ['P1', 'P4'])
  const beds = rt.run('bedSearch', { patientId: 'P1' }, { actor })
  assert.deepEqual(ids(beds.set.objects), ['B101'])
  assert.deepEqual(beds.assessments.map((a) => a.reasons.map((r) => r.code)), [[], ['BED_NOT_READY'], ['MISSING_EQUIPMENT'], ['BED_RESERVED']])
  const nurses = rt.run('nurseSearch', { patientId: 'P1', bedId: 'B101' }, { actor })
  assert.deepEqual(ids(nurses.set.objects), ['N1'])
  assert.deepEqual(nurses.assessments.map((a) => a.reasons.map((r) => r.code)), [[], ['NO_CAPACITY'], ['WRONG_SHIFT']])
  assert.deepEqual(rt.run('bedSearch', { patientId: 'P2' }, { actor }).set.objects, [])
  assert.throws(() => rt.run('bedSearch', { patientId: 'missing' }, { actor }), /missing or hidden/)
  assert.equal(rt.preview('allocate', plan, { actor }).ok, true)
  assert.deepEqual(rt.auditLog(), [])
  assert.deepEqual(rt.search('Allocation', { actor }).objects, [])
})

test('hospital records one atomic plan; source readiness is unchanged and the plan consumes effective resources after refresh', (t) => {
  const { rt, sources } = setup(t)
  const before = structuredClone(sources)
  assert.deepEqual(ids(rt.run('bedSearch', { patientId: 'P4' }, { actor }).set.objects), ['B101'])
  const otherPlan = { ...plan, patientId: 'P4', allocationId: 'PLAN2' }
  assert.equal(rt.preview('allocate', plan, { actor }).ok, true)
  assert.equal(rt.preview('allocate', otherPlan, { actor }).ok, true)
  assert.deepEqual(rt.auditLog(), [])
  assert.equal(rt.run('allocate', plan, { actor }).ok, true)
  const saved = rt.get('Allocation', 'PLAN1', { actor })!
  for (const [link, expected] of [['patientAllocations', 'P1'], ['bedAllocations', 'B101'], ['nurseAllocations', 'N1']] as const) {
    assert.deepEqual(ids(rt.traverse(saved, link, { actor }).objects), [expected])
  }
  assert.deepEqual(sources, before)
  assert.equal(rt.run('bedSearch', { patientId: 'P1' }, { actor }).set.objects.length, 0)
  const forOther = rt.run('bedSearch', { patientId: 'P4' }, { actor })
  assert.equal(forOther.set.objects.length, 0)
  assert.deepEqual(forOther.assessments[0].reasons.map((r) => r.code), ['BED_RESERVED'], 'P4 is still eligible as a patient; the resource is consumed')
  const nurse = rt.run('nurseSearch', { patientId: 'P4', bedId: 'B101' }, { actor }).assessments[0]
  assert.equal(nurse.reasons.some((r) => r.code === 'NO_CAPACITY'), true)
  const refused = rt.run('allocate', otherPlan, { actor })
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.equal(refused.error.code, 'BED_RESERVED')
  assert.equal(rt.get('Allocation', 'PLAN2', { actor }), undefined)
  rt.load(integrate(sources))
  assert.equal(rt.run('bedSearch', { patientId: 'P4' }, { actor }).set.objects.length, 0)
  assert.deepEqual(ids(rt.traverse(saved, 'bedAllocations', { actor }).objects), ['B101'])
  assert.deepEqual(rt.auditLog().map((e) => e.status), ['applied', 'rejected'])
})

test('hospital final Action checks the combination and current source snapshot, not an earlier candidate result', (t) => {
  const { rt, sources } = setup(t)
  const beds = rt.run('bedSearch', { patientId: 'P1' }, { actor })
  assert.equal(beds.set.objects[0].pk, 'B101')
  for (const change of [{ bedId: 'B102' }, { bedId: 'B103' }, { nurseId: 'N3' }, { patientId: 'P2' }]) {
    assert.equal(rt.run('allocate', { ...plan, ...change }, { actor }).ok, false)
  }
  assert.deepEqual(rt.search('Allocation', { actor }).objects, [])
  assert.equal(rt.preview('allocate', plan, { actor }).ok, true)
  sources.nurses[0].slots = 0
  rt.load(integrate(sources))
  const rejected = rt.run('allocate', plan, { actor })
  assert.equal(rejected.ok, false)
  if (!rejected.ok) assert.equal(rejected.error.code, 'NO_CAPACITY')
  assert.deepEqual(rt.search('Allocation', { actor }).objects, [])
  const bed = rt.get('Bed', 'B101', { actor })!
  assert.deepEqual(rt.traverse(bed, 'bedAllocations', { actor }).objects, [])
})

test('hospital refuses an inconsistent selected bed/nurse pair even when each appeared in a candidate search', (t) => {
  const { rt, sources } = setup(t)
  sources.beds.push({ ...sources.beds[0], id: 'B105', area: 'B' })
  rt.load(integrate(sources))
  assert.deepEqual(ids(rt.run('bedSearch', { patientId: 'P1' }, { actor }).set.objects), ['B101', 'B105'])
  assert.deepEqual(ids(rt.run('nurseSearch', { patientId: 'P1', bedId: 'B101' }, { actor }).set.objects), ['N1'])
  assert.deepEqual(rt.run('nurseSearch', { patientId: 'P1', bedId: 'B105' }, { actor }).set.objects, [])
  const result = rt.run('allocate', { ...plan, bedId: 'B105' }, { actor })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'WRONG_AREA')
  assert.deepEqual(rt.search('Allocation', { actor }).objects, [])
})
