import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildMcpServer } from '../../src/mcp.js'
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
  const equipment = rt.filter(rt.search('Equipment', { actor }), [{ property: 'inspection', op: 'eq', value: 'anomaly' }])
  assert.deepEqual(ids(equipment.objects), ['PRESS-1'])
  const lots = rt.filter(rt.pivot(equipment, 'producedOn', { actor }), [
    { property: 'manufacturedAt', op: 'gte', value: '2026-09-06T00:00:00+09:00' },
    { property: 'manufacturedAt', op: 'lt', value: '2026-09-07T00:00:00+09:00' },
  ])
  assert.deepEqual(ids(lots.objects), ['L1', 'L3'])
  assert.equal(lots.objects.every((lot) => lot.properties.releaseInspection === 'passed'), true)
  assert.deepEqual(rt.filter(lots, [{ property: 'releaseInspection', op: 'eq', value: 'passed' }]), lots)
  const affected = rt.pivot(lots, 'lotLines', { actor })
  assert.deepEqual(ids(affected.objects), ['SL1', 'SL3', 'SL5', 'SL4'])
  const shipments = rt.filter(rt.pivot(affected, 'shipmentLines', { actor }), [{ property: 'status', op: 'eq', value: 'shipped' }])
  const lines = rt.intersect(affected, rt.pivot(shipments, 'shipmentLines', { actor }))
  assert.deepEqual(ids(lines.objects), ['SL1', 'SL3', 'SL4'])
  assert.deepEqual(ids(shipments.objects), ['S1', 'S2'])
  assert.equal(shipments.objects.every((s) => s.properties.status === 'shipped'), true)
  assert.deepEqual(ids(rt.pivot(shipments, 'customerShipments', { actor }).objects), ['C1'])
  const params = {
    customerId: 'C1', equipmentId: 'PRESS-1', taskId: 'TASK1', reason: 'Review contact and reinspection',
    after: '2026-09-06T00:00:00+09:00', before: '2026-09-07T00:00:00+09:00', lineIds: ids(lines.objects),
  }
  assert.equal(rt.preview('createContactTask', params, { actor }).ok, true)
  assert.deepEqual(rt.auditLog(), [])
  assert.equal(rt.search('ContactTask', { actor }).objects.length, 0)
  for (const lineIds of [['SL2'], ['SL5'], ['SL6'], ['SL1', 'SL1']]) {
    assert.equal(rt.run('createContactTask', { ...params, lineIds }, { actor }).ok, false)
  }
  assert.equal(rt.search('ContactTask', { actor }).objects.length, 0)
  assert.equal(rt.run('createContactTask', params, { actor }).ok, true)
  rt.load(integrate(sources))
  const task = rt.get('ContactTask', 'TASK1', { actor })!
  assert.deepEqual(ids(rt.traverse(task, 'contactLots', { actor }).objects), ['L1', 'L3'])
  assert.deepEqual(ids(rt.traverse(task, 'contactLines', { actor }).objects), ['SL1', 'SL3', 'SL4'])
  assert.deepEqual(ids(rt.traverse(task, 'customerContacts', { actor }).objects), ['C1'])
  assert.equal(rt.auditLog({ status: 'applied' }).length, 1)
})

test('factory impact counts affected line quantities once across converging paths', (t) => {
  const { rt } = setup(t)
  const equipment = rt.filter(rt.search('Equipment', { actor }), [{ property: 'id', op: 'in', value: ['PRESS-1', 'OVEN-1'] }])
  const lots = rt.pivot(equipment, 'producedOn', { actor })
  assert.deepEqual(ids(lots.objects), ['L1', 'L2', 'L3'])
  const impact = rt.run('customerImpact', { lotIds: [...ids(lots.objects), 'L1'] }, { actor })
  assert.deepEqual(impact.aggregation.values, [
    { key: 'C1', pks: ['C1'], affectedUnits: 50, shipmentCount: 2 },
    { key: 'C2', pks: ['C2'], affectedUnits: 15, shipmentCount: 1 },
  ])
  assert.deepEqual(ids(impact.evidence[0].lines.objects), ['SL1', 'SL3', 'SL4'])
  assert.deepEqual(rt.run('customerImpact', { lotIds: [] }, { actor }).aggregation.set, { type: 'Customer', objects: [] })
  assert.deepEqual(rt.auditLog(), [])
})

for (const status of ['pending', 'held']) {
  test(`factory excludes ${status} shipments before calculating impact and proposing contact evidence`, (t) => {
    const { rt, sources } = setup(t)
    sources.wms.prepare('UPDATE shipment SET status = ?, shipped_at = NULL WHERE id = ?').run(status, 'S2')
    rt.load(integrate(sources))
    const impact = rt.run('customerImpact', { lotIds: ['L1', 'L3'] }, { actor })
    assert.deepEqual(impact.aggregation.values, [
      { key: 'C1', pks: ['C1'], affectedUnits: 10, shipmentCount: 1 },
    ])
    assert.deepEqual(ids(impact.evidence[0].lines.objects), ['SL1'], 'exclude unshipped lines and unrelated L4 packed in S1')
    const request = {
      customerId: 'C1', equipmentId: 'PRESS-1', taskId: 'CONTACT', reason: 'Review affected shipped products',
      after: '2026-09-06T00:00:00+09:00', before: '2026-09-07T00:00:00+09:00',
      lineIds: ids(impact.evidence[0].lines.objects),
    }
    assert.equal(rt.run('createContactTask', request, { actor }).ok, true)
    assert.deepEqual(ids(rt.traverse(rt.get('ContactTask', 'CONTACT', { actor })!, 'contactLines', { actor }).objects), ['SL1'])

    sources.wms.prepare('UPDATE shipment SET status = ?, shipped_at = NULL WHERE id = ?').run(status, 'S1')
    rt.load(integrate(sources))
    const none = rt.run('customerImpact', { lotIds: ['L1', 'L3'] }, { actor })
    assert.deepEqual(none.aggregation.set, { type: 'Customer', objects: [] })
    assert.deepEqual(none.aggregation.values, [])
    assert.deepEqual(none.evidence, [])
    const stale = rt.run('createContactTask', { ...request, taskId: 'STALE' }, { actor })
    assert.equal(stale.ok, false)
    if (!stale.ok) assert.equal(stale.error.code, 'INVALID_EVIDENCE')
    assert.equal(rt.get('ContactTask', 'STALE', { actor }), undefined)
  })
}

test('MCP clients discover customer impact, filter its metrics and record the returned evidence', async (t) => {
  const app = setup(t)
  const server = buildMcpServer(app.rt, { agent: 'investigator' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'factory-test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  t.after(async () => { await client.close(); await server.close() })
  const tool = (await client.listTools()).tools.find((tool) => tool.name === 'customer_impact')!
  assert.equal(tool.annotations?.readOnlyHint, true)
  assert.deepEqual(tool.inputSchema.required, ['lotIds'])
  const readJson = (result: Awaited<ReturnType<typeof client.callTool>>) => {
    assert.notEqual(result.isError, true)
    assert.ok(Array.isArray(result.content))
    const block = result.content[0]
    assert.equal(block.type, 'text')
    return JSON.parse(block.text as string)
  }
  const impact = readJson(await client.callTool({ name: 'customer_impact', arguments: { lotIds: ['L1', 'L3'] } })) as
    ReturnType<typeof app.rt.ontology.functions.customerImpact.run>
  assert.deepEqual(impact.aggregation.values, [{ key: 'C1', pks: ['C1'], affectedUnits: 50, shipmentCount: 2 }])
  const selected = readJson(await client.callTool({ name: 'filter_customer', arguments: {
    source: impact.aggregation, where: [{ property: 'affectedUnits', op: 'gte', value: 40 }],
  } })) as typeof impact.aggregation
  assert.deepEqual(ids(selected.set.objects), ['C1'])
  assert.deepEqual(app.rt.auditLog(), [])
  const evidence = impact.evidence.find((e) => e.customerId === selected.set.objects[0].pk)!
  readJson(await client.callTool({ name: 'create_contact_task', arguments: {
    customerId: evidence.customerId, equipmentId: 'PRESS-1', taskId: 'MCP-CONTACT',
    after: '2026-09-06T00:00:00+09:00', before: '2026-09-07T00:00:00+09:00',
    lineIds: ids(evidence.lines.objects), reason: 'Review contact and reinspection',
  } }))
  const task = app.rt.get('ContactTask', 'MCP-CONTACT', { actor })!
  assert.deepEqual(ids(app.rt.traverse(task, 'contactLines', { actor }).objects), ['SL1', 'SL3', 'SL4'])
  assert.deepEqual(app.rt.auditLog().map((entry) => [entry.status, entry.actor]), [['applied', 'agent:investigator']])
})
