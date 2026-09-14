/** Run: pnpm demo:finance. Integer amounts are yen. */
import { integrate } from './integrate.js'
import { createFinance } from './runtime.js'
import { heading as h, log } from '../demo-output.js'

const app = createFinance()
const { rt } = app
const actor = 'user:investigator'
const scope = { originIds: ['A', 'B', 'C'], after: '2026-09-08T12:00:00+09:00', before: '2026-09-09T00:00:00+09:00' }
try {
  h('1. Read: investigate a transaction-monitoring referral')
  log('September 8: the monitoring team reports unusually frequent morning deposits into A, B and C.')
  log('Review their afternoon payments to find shared recipients and identify invoices and payment purposes to verify.')
  log('The morning report is supplied context; this demo starts from the outgoing transfer records.')
  log('Investigation scope:', scope)

  h('2. Read: trace outgoing transfers and intersect recipients')
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
  log('Common to every origin:', common.objects.map((a) => a.pk))

  h('3. Read: compare sender counts, amounts and evidence')
  const summary = rt.call('recipientSummary', scope, { actor })
  console.table(summary.aggregation.values.map(({ key, metrics }) => ({ key, ...metrics })))
  const selected = rt.filter(summary.aggregation, (row) => row.metrics.senderCount >= 2)
  log('At least two distinct senders:', selected.set.objects.map((a) => a.pk))
  log('X has four transfers from three senders, totalling 5,100,000 yen.')
  const account = common.objects[0]
  const evidence = summary.evidence.find((e) => e.accountId === account.pk)!
  log('Context to verify:', account.properties.context)
  log('Evidence transfer IDs:', evidence.transfers.objects.map((t) => t.pk))

  h('4. Write: record a case for checking the payments')
  const request = {
    ...summary.scope, accountId: account.pk, investigationId: 'CASE-X',
    transferIds: evidence.transfers.objects.map((t) => t.pk),
    reason: 'Request invoices and payment purposes for the common recipient; a legitimate explanation remains possible',
  }
  log('Create case:', rt.execute('openInvestigation', request, { actor }))
  log('No account was frozen. Temporal sequence does not identify the same funds uniquely.')

  h('5. Re-index: the case and its evidence links survive')
  rt.load(integrate(app.sources))
  const saved = rt.get('Investigation', 'CASE-X', { actor })!
  log('Evidence after source refresh:', rt.traverse(saved, 'investigationTransfers', { actor }))

  h('6. Audit log (applied AND rejected attempts)')
  for (const e of rt.auditLog()) {
    log(`  #${e.seq} ${e.status.padEnd(8)} ${e.action}(${e.target}) by ${e.actor}${e.error ? ` — ${e.error.code}` : ''}`)
  }
} finally {
  app.close()
}
