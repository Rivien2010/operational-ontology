import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildMcpServer, type AggregationResult, type ObjectOf, type ObjectSet } from '../../src/index.js'
import type { Finance } from './ontology.js'
import { createFinance } from './runtime.js'
import { integrate } from './integrate.js'

const actor = 'user:investigator'
const scope = { originIds: ['A', 'B', 'C'], after: '2026-09-08T12:00:00+09:00', before: '2026-09-09T00:00:00+09:00' }
const request = { ...scope, accountId: 'X', investigationId: 'CASE-X', transferIds: ['T1a', 'T1b', 'T3', 'T4'], reason: 'Request invoice references' }
const ids = (objects: readonly { pk: string }[]) => objects.map((o) => o.pk)
function setup(t: TestContext) {
  const app = createFinance()
  t.after(() => app.close())
  return app
}

test('finance distinguishes recipient intersection, distinct senders and repeated transfers in the supplied scope', (t) => {
  const { rt } = setup(t)
  const paths = scope.originIds.map((id) => {
    const transfers = rt.filter(rt.traverse(rt.get('Account', id, { actor })!, 'outgoing', { actor }), (object) => {
      const time = Date.parse(object.properties.occurredAt as string)
      return time >= Date.parse(scope.after) && time < Date.parse(scope.before)
    })
    return rt.pivot(transfers, 'incoming', { actor })
  })
  assert.deepEqual(ids(paths.reduce((a, b) => rt.intersect(a, b)).objects), ['X'])
  const summary = rt.run('recipientSummary', { ...scope, originIds: ['A', 'B', 'C', 'A'] }, { actor })
  assert.deepEqual(summary.scope.originIds, ['A', 'B', 'C'])
  const x = summary.aggregation.values.find((row) => row.key === 'X')!
  assert.deepEqual(x, { key: 'X', pks: ['X'], senderCount: 3, transactionCount: 4, totalAmount: 5100000 })
  const selected = rt.filter(summary.aggregation, (row) => (row.senderCount as number) >= 2)
  assert.deepEqual(ids(selected.set.objects).sort(), ['W', 'X'])
  const evidence = summary.evidence.find((e) => e.accountId === 'X')!
  assert.deepEqual(ids(evidence.transfers.objects), ['T1a', 'T1b', 'T3', 'T4'])
  assert.deepEqual(ids(evidence.senders.objects), ['A', 'B', 'C'])
  assert.deepEqual(rt.auditLog(), [])
  const empty = rt.run('recipientSummary', { ...scope, after: '2027-01-01T00:00:00Z', before: '2027-01-02T00:00:00Z' }, { actor })
  assert.deepEqual(empty.aggregation.set, { type: 'Account', objects: [] })
  assert.throws(() => rt.run('recipientSummary', { ...scope, before: scope.after }, { actor }), /after must precede/)
  assert.throws(() => rt.run('recipientSummary', { ...scope, originIds: ['missing'] }, { actor }), /missing or hidden/)
})

test('finance saves target, scope and evidence as a case; rejects unrelated evidence without partial writes', (t) => {
  const { rt, sources } = setup(t)
  const original = structuredClone(sources)
  assert.equal(rt.preview('openInvestigation', request, { actor }).ok, true)
  assert.deepEqual(rt.auditLog(), [])
  assert.deepEqual(rt.search('Investigation', { actor }).objects, [])
  for (const transferIds of [['T2'], ['T8'], ['T9'], ['T10'], ['T1a', 'T1a']]) {
    assert.equal(rt.run('openInvestigation', { ...request, transferIds }, { actor }).ok, false)
  }
  const invalidScopes: Array<[Partial<typeof request>, string]> = [[{ before: scope.after }, 'INVALID_WINDOW'], [{ originIds: ['missing'] }, 'ORIGIN_MISSING']]
  for (const [change, code] of invalidScopes) {
    const result = rt.run('openInvestigation', { ...request, ...change }, { actor })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, code)
  }
  assert.deepEqual(rt.search('Investigation', { actor }).objects, [])
  assert.equal(rt.run('openInvestigation', request, { actor }).ok, true)
  assert.deepEqual(sources, original)
  rt.load(integrate(sources))
  const saved = rt.get('Investigation', 'CASE-X', { actor })!
  assert.equal(saved.properties.after, scope.after)
  assert.deepEqual(ids(rt.traverse(saved, 'accountInvestigations', { actor }).objects), ['X'])
  assert.deepEqual(ids(rt.traverse(saved, 'investigationOrigins', { actor }).objects), ['A', 'B', 'C'])
  assert.deepEqual(ids(rt.traverse(saved, 'investigationTransfers', { actor }).objects), request.transferIds)
  assert.equal(rt.auditLog({ status: 'applied' }).length, 1)
})

test('finance rechecks evidence relationships after a source correction', (t) => {
  const { rt, sources } = setup(t)
  assert.equal(rt.preview('openInvestigation', request, { actor }).ok, true)
  sources.transfers[0].recipient_id = 'Y'
  rt.load(integrate(sources))
  const result = rt.run('openInvestigation', request, { actor })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'INVALID_EVIDENCE')
  assert.equal(rt.get('Investigation', 'CASE-X', { actor }), undefined)
})

test('MCP combines client-side date/metric filters with pivots and a validated case Action', async (t) => {
  const app = createFinance()
  const server = buildMcpServer(app.rt, { agent: 'reviewer' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'finance-test', version: '0.0.0' })
  await Promise.all([server.connect(st), client.connect(ct)])
  t.after(async () => { await client.close(); await server.close(); app.close() })
  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await client.callTool({ name, arguments: args })
    assert.notEqual(result.isError, true, JSON.stringify(result))
    assert.ok(Array.isArray(result.content))
    const block = result.content[0]
    assert.equal(block.type, 'text')
    return JSON.parse(block.text as string) as T
  }
  const listed = (await client.listTools()).tools
  assert.equal(listed.find((tool) => tool.name === 'recipient_summary')?.annotations?.readOnlyHint, true)
  const outgoing = await call<ObjectSet>('pivot_outgoing', { source: { type: 'Account', pks: ['A', 'B', 'C'] } })
  const afternoon = outgoing.objects.filter((object) => {
    const time = Date.parse(object.properties.occurredAt as string)
    return time >= Date.parse(scope.after) && time < Date.parse(scope.before)
  })
  assert.equal(afternoon.length, 8)
  const recipients = await call<ObjectSet>('pivot_incoming', { source: { type: 'Transfer', pks: ids(afternoon) } })
  assert.deepEqual(ids(recipients.objects).sort(), ['W', 'X', 'Y', 'Z'])
  const summary = await call<{ aggregation: AggregationResult<ObjectOf<Finance, 'Account'>> }>('recipient_summary', scope)
  const selected = summary.aggregation.values.filter((row) => (row.senderCount as number) >= 2)
  const selectedIds = [...new Set(selected.flatMap((row) => row.pks))]
  assert.deepEqual(selectedIds.sort(), ['W', 'X'])
  assert.equal(selected.find((row) => row.key === 'X')!.totalAmount, 5100000)
  assert.deepEqual(app.rt.auditLog(), [])
  await call('open_investigation', request)
  assert.equal(app.rt.auditLog()[0].actor, 'agent:reviewer')
})
