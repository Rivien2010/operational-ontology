import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildMcpServer } from '../../src/mcp.js'
import { objectSet, type AggregationResult, type ObjectSet } from '../../src/core.js'
import { integrate } from './integrate.js'
import { createFactory } from './runtime.js'

const actor = 'user:factory-ops'
const ids = (objects: readonly { pk: string }[]) => objects.map((object) => object.pk)
function setup(t: TestContext) {
  const app = createFactory()
  t.after(() => app.close())
  return app
}

test('factory investigates a supplied manufacturing window and records shipped-line evidence for one customer', (t) => {
  const { rt, sources } = setup(t)
  const equipment = rt.filter(rt.search('Equipment', { actor }), (object) => object.properties.inspection === 'anomaly')
  assert.deepEqual(ids(equipment.objects), ['PRESS-1'])
  const lots = rt.filter(rt.pivot(equipment, 'producedOn', { actor }), (object) => {
    const time = Date.parse(object.properties.manufacturedAt as string)
    return time >= Date.parse('2026-09-06T00:00:00+09:00') && time < Date.parse('2026-09-07T00:00:00+09:00')
  })
  assert.deepEqual(ids(lots.objects), ['L1', 'L3'])
  assert.equal(lots.objects.every((lot) => lot.properties.releaseInspection === 'passed'), true)
  assert.deepEqual(rt.filter(lots, (object) => object.properties.releaseInspection === 'passed'), lots)
  const affected = rt.pivot(lots, 'lotLines', { actor })
  assert.deepEqual(ids(affected.objects), ['SL1', 'SL3', 'SL5', 'SL4'])
  const shipments = rt.filter(rt.pivot(affected, 'shipmentLines', { actor }), (object) => object.properties.status === 'shipped')
  const lines = rt.intersect(affected, rt.pivot(shipments, 'shipmentLines', { actor }))
  assert.deepEqual(ids(lines.objects), ['SL1', 'SL3', 'SL4'])
  assert.deepEqual(rt.aggregate(lines, { sum: 'units' }).values, [
    { key: null, pks: ['SL1', 'SL3', 'SL4'], metrics: { count: 3, sum: 50 } },
  ])
  assert.deepEqual(ids(shipments.objects), ['S1', 'S2'])
  assert.equal(shipments.objects.every((s) => s.properties.status === 'shipped'), true)
  assert.deepEqual(ids(rt.pivot(shipments, 'customerShipments', { actor }).objects), ['C1'])
  const params = {
    customerId: 'C1', equipmentId: 'PRESS-1', taskId: 'TASK1', reason: 'Review contact and reinspection',
    after: '2026-09-06T00:00:00+09:00', before: '2026-09-07T00:00:00+09:00', lineIds: ids(lines.objects),
  }
  assert.deepEqual(rt.auditLog(), [])
  assert.equal(rt.search('ContactTask', { actor }).objects.length, 0)
  for (const lineIds of [['SL2'], ['SL5'], ['SL6'], ['SL1', 'SL1']]) {
    assert.equal(rt.execute('createContactTask', { ...params, lineIds }, { actor }).ok, false)
  }
  assert.equal(rt.search('ContactTask', { actor }).objects.length, 0)
  assert.equal(rt.execute('createContactTask', params, { actor }).ok, true)
  rt.load(integrate(sources))
  const task = rt.get('ContactTask', 'TASK1', { actor })!
  assert.deepEqual(ids(rt.traverse(task, 'contactLots', { actor }).objects), ['L1', 'L3'])
  assert.deepEqual(ids(rt.traverse(task, 'contactLines', { actor }).objects), ['SL1', 'SL3', 'SL4'])
  assert.deepEqual(ids(rt.traverse(task, 'customerContacts', { actor }).objects), ['C1'])
  assert.equal(rt.auditLog({ status: 'applied' }).length, 1)
})

test('factory exploration deduplicates converging production paths without losing shipment lines', (t) => {
  const { rt } = setup(t)
  const equipment = rt.filter(rt.search('Equipment', { actor }), (object) => ['PRESS-1', 'OVEN-1'].includes(object.properties.id as string))
  const lots = rt.pivot(equipment, 'producedOn', { actor })
  assert.deepEqual(ids(lots.objects), ['L1', 'L2', 'L3'])
  const lines = rt.pivot(lots, 'lotLines', { actor })
  assert.deepEqual(ids(lines.objects), ['SL1', 'SL3', 'SL5', 'SL2', 'SL4'])
  assert.deepEqual(rt.aggregate(lines, { sum: 'units' }).values, [
    { key: null, pks: ['SL1', 'SL3', 'SL5', 'SL2', 'SL4'], metrics: { count: 5, sum: 75 } },
  ])
  assert.deepEqual(rt.auditLog(), [])
})

for (const status of ['pending', 'held']) {
  test(`factory excludes ${status} shipments before calculating impact and proposing contact evidence`, (t) => {
    const { rt, sources } = setup(t)
    sources.wms.prepare('UPDATE shipment SET status = ?, shipped_at = NULL WHERE id = ?').run(status, 'S2')
    rt.load(integrate(sources))
    const lots = objectSet('Lot', ['L1', 'L3'].map((id) => rt.get('Lot', id, { actor })!))
    const affected = rt.pivot(lots, 'lotLines', { actor })
    const shipments = rt.filter(rt.pivot(affected, 'shipmentLines', { actor }), (object) => object.properties.status === 'shipped')
    const evidence = rt.intersect(affected, rt.pivot(shipments, 'shipmentLines', { actor }))
    assert.deepEqual(ids(evidence.objects), ['SL1'], 'exclude unshipped lines and unrelated L4 packed in S1')
    assert.equal(evidence.objects[0].properties.units, 10)
    const request = {
      customerId: 'C1', equipmentId: 'PRESS-1', taskId: 'CONTACT', reason: 'Review affected shipped products',
      after: '2026-09-06T00:00:00+09:00', before: '2026-09-07T00:00:00+09:00',
      lineIds: ids(evidence.objects),
    }
    assert.equal(rt.execute('createContactTask', request, { actor }).ok, true)
    assert.deepEqual(ids(rt.traverse(rt.get('ContactTask', 'CONTACT', { actor })!, 'contactLines', { actor }).objects), ['SL1'])

    sources.wms.prepare('UPDATE shipment SET status = ?, shipped_at = NULL WHERE id = ?').run(status, 'S1')
    rt.load(integrate(sources))
    const stale = rt.execute('createContactTask', { ...request, taskId: 'STALE' }, { actor })
    assert.equal(stale.ok, false)
    if (!stale.ok) assert.equal(stale.error.code, 'INVALID_EVIDENCE')
    assert.equal(rt.get('ContactTask', 'STALE', { actor }), undefined)
  })
}

test('MCP clients discover factory evidence through client filters, pivots, intersection and whole-set aggregation', async (t) => {
  const app = setup(t)
  const server = buildMcpServer(app.rt, { agent: 'investigator' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'factory-test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  t.after(async () => { await client.close(); await server.close() })
  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await client.callTool({ name, arguments: args })
    assert.notEqual(result.isError, true)
    assert.ok(Array.isArray(result.content))
    const block = result.content[0]
    assert.equal(block.type, 'text')
    return JSON.parse(block.text as string) as T
  }
  const window = { after: '2026-09-06T00:00:00+09:00', before: '2026-09-07T00:00:00+09:00' }
  const allEquipment = await call<ObjectSet>('search_equipment', {})
  // These predicates run in the client; selected IDs return to the server.
  const equipment = allEquipment.objects.filter((object) => object.properties.inspection === 'anomaly')
  const produced = await call<ObjectSet>('pivot_produced_on', { source: { type: 'Equipment', pks: ids(equipment) } })
  const lots = produced.objects.filter((object) => {
    const time = Date.parse(object.properties.manufacturedAt as string)
    return time >= Date.parse(window.after) && time < Date.parse(window.before)
  })
  const lines = await call<ObjectSet>('pivot_lot_lines', { source: { type: 'Lot', pks: ids(lots) } })
  const allShipments = await call<ObjectSet>('pivot_shipment_lines', { source: { type: 'ShipmentLine', pks: ids(lines.objects) } })
  const shipments = allShipments.objects.filter((object) => object.properties.status === 'shipped')
  const customers = await call<ObjectSet>('pivot_customer_shipments', { source: { type: 'Shipment', pks: ids(shipments) } })
  assert.deepEqual(ids(customers.objects), ['C1'])
  const packed = await call<ObjectSet>('pivot_shipment_lines', { source: { type: 'Shipment', pks: ids(shipments) } })
  const evidence = await call<ObjectSet>('intersect_shipment_line', { left: ids(lines.objects), right: ids(packed.objects) })
  assert.deepEqual(ids(evidence.objects), ['SL1', 'SL3', 'SL4'])
  const impact = await call<AggregationResult>('aggregate_shipment_line', { pks: ids(evidence.objects), sum: 'units' })
  assert.deepEqual(impact.values, [{ key: null, pks: ['SL1', 'SL3', 'SL4'], metrics: { count: 3, sum: 50 } }])
  assert.deepEqual(app.rt.auditLog(), [])
  await call('create_contact_task', {
    customerId: customers.objects[0].pk, equipmentId: equipment[0].pk, taskId: 'MCP-CONTACT', ...window,
    lineIds: ids(evidence.objects), reason: 'Review contact and reinspection',
  })
  const task = app.rt.get('ContactTask', 'MCP-CONTACT', { actor })!
  assert.deepEqual(ids(app.rt.traverse(task, 'contactLines', { actor }).objects), ['SL1', 'SL3', 'SL4'])
  assert.deepEqual(app.rt.auditLog().map((entry) => [entry.status, entry.actor]), [['applied', 'agent:investigator']])
})
