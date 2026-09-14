/** Run: pnpm demo:finance. Integer amounts are yen. */
import { integrate } from './integrate.js'
import { createFinance } from './runtime.js'

const app = createFinance()
const { rt } = app
const actor = 'user:investigator'
const scope = { originIds: ['A', 'B', 'C'], after: '2026-09-08T12:00:00+09:00', before: '2026-09-09T00:00:00+09:00' }
try {
  const paths = scope.originIds.map((id) => {
    const outgoing = rt.traverse(rt.get('Account', id, { actor })!, 'outgoing', { actor })
    const afternoon = rt.filter(outgoing, (object) => {
      const time = Date.parse(object.properties.occurredAt as string)
      return time >= Date.parse(scope.after) && time < Date.parse(scope.before)
    })
    return { origin: id, transfers: afternoon, recipients: rt.pivot(afternoon, 'incoming', { actor }) }
  })
  console.table(paths.map((p) => ({ origin: p.origin, recipients: p.recipients.objects.map((a) => a.pk).join(', ') })))
  const common = paths.map((p) => p.recipients).reduce((a, b) => rt.intersect(a, b))
  console.log('Common to every origin:', common.objects.map((a) => a.pk))

  const summary = rt.run('recipientSummary', scope, { actor })
  console.table(summary.aggregation.values)
  const selected = rt.filter(summary.aggregation, (row) => (row.senderCount as number) >= 2)
  console.log('At least two distinct senders:', selected.set.objects.map((a) => a.pk))
  console.log('X has four transfers from three senders, totalling 5,100,000 yen.')
  const account = common.objects[0]
  const evidence = summary.evidence.find((e) => e.accountId === account.pk)!
  console.log('Context to verify:', account.properties.context)
  console.log('Evidence transfer IDs:', evidence.transfers.objects.map((t) => t.pk))
  const request = {
    ...summary.scope, accountId: account.pk, investigationId: 'CASE-X',
    transferIds: evidence.transfers.objects.map((t) => t.pk),
    reason: 'Request invoices and payment purposes for the common recipient; a legitimate explanation remains possible',
  }
  console.log('Preview:', rt.preview('openInvestigation', request, { actor }))
  console.log('Create case:', rt.run('openInvestigation', request, { actor }))
  rt.load(integrate(app.sources))
  const saved = rt.get('Investigation', 'CASE-X', { actor })!
  console.log('Evidence after source refresh:', rt.traverse(saved, 'investigationTransfers', { actor }))
  console.log('No account was frozen. Temporal sequence does not identify the same funds uniquely.')
  console.log('Audit:', rt.auditLog())
} finally {
  app.close()
}
