/** Run: pnpm demo:finance. Integer amounts are yen. */
import { createFinance } from './runtime.js'
import { heading as h, log, showObjects, trace } from '../demo-output.js'

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

  h('2. Read: trace outgoing transfers to recipient accounts')
  const paths = scope.originIds.map((id) => {
    const account = rt.get('Account', id, { actor })!
    const outgoing = rt.traverse(account, 'outgoing', { actor })
    trace(`Traverse outgoing (forward): Account ${id} → Transfer`, { account }, outgoing)
    console.table(outgoing.objects.map(({ pk, properties }) => ({ transfer: pk, occurredAt: properties.occurredAt, yen: properties.amount })))
    const afternoon = rt.filter(outgoing, (object) => {
      const time = Date.parse(object.properties.occurredAt as string)
      return time >= Date.parse(scope.after) && time < Date.parse(scope.before)
    })
    trace(`Filter ${id}'s transfers: ${scope.after} <= time < ${scope.before}`, { outgoing }, afternoon)
    const recipients = rt.pivot(afternoon, 'incoming', { actor })
    trace(`Pivot incoming (reverse): ${id}'s scoped transfers → recipient accounts`, { afternoon }, recipients)
    return { origin: id, transfers: afternoon, recipients }
  })
  log('T1a and T1b are separate transfers to X. Pivot includes X once; the transfer sets retain both records.')

  h('3. Transform: compare recipient sets by identity')
  const [fromA, fromB, fromC] = paths.map((path) => path.recipients)
  const sharedAB = rt.intersect(fromA, fromB)
  trace('Intersect A ∩ B: recipients shared by A and B', { A: fromA, B: fromB }, sharedAB)
  const common = rt.intersect(sharedAB, fromC)
  trace('Intersect (A ∩ B) ∩ C: recipients shared by all three', { 'A ∩ B': sharedAB, C: fromC }, common)
  log('W survives A ∩ B but drops out when intersecting with C. The common recipient is X.')
  log('These operations compare Account IDs. They do not add amounts or count transfers.')

  h('4. Read / Transform: return from X to the evidence transfers')
  const account = common.objects[0]
  const incoming = rt.pivot(common, 'incoming', { actor })
  trace('Pivot incoming (forward): common recipient → all incoming transfers', { common }, incoming)
  const [aTransfers, bTransfers, cTransfers] = paths.map((path) => path.transfers)
  const abTransfers = rt.union(aTransfers, bTransfers)
  trace('Union: scoped transfers from A ∪ B', { A: aTransfers, B: bTransfers }, abTransfers)
  const scopedTransfers = rt.union(abTransfers, cTransfers)
  trace('Union: scoped transfers from (A ∪ B) ∪ C', { 'A ∪ B': abTransfers, C: cTransfers }, scopedTransfers)
  const evidence = rt.intersect(incoming, scopedTransfers)
  trace('Intersect: incoming to X ∩ transfers in the origin/time scope', { incoming, scopedTransfers }, evidence)
  log('T8 is on the previous day, T10 is in the morning, and T9 comes from D. They are outside this investigation scope.')
  console.table(evidence.objects.map(({ pk, properties }) => ({ transfer: pk, occurredAt: properties.occurredAt, yen: properties.amount })))
  const senders = rt.pivot(evidence, 'outgoing', { actor })
  trace('Pivot outgoing (reverse): evidence transfers → distinct senders', { evidence }, senders)
  const totalAmount = evidence.objects.reduce((sum, transfer) => sum + (transfer.properties.amount as number), 0)
  log('Aggregate the retained evidence:', { transfers: evidence.objects.length, senders: senders.objects.length, yen: totalAmount })
  log('Four transfers from three senders: A sends twice. Sum the transfer records, retaining both payments from A.')

  h('5. Function: compare metrics across recipients')
  log('Function recipientSummary counts distinct senders and sums the retained evidence transfers for each recipient.')
  log('    params:', scope)
  const summary = rt.call('recipientSummary', scope, { actor })
  showObjects('recipient accounts', summary.aggregation.set)
  console.table(summary.aggregation.values.map(({ key, pks, metrics }) => ({ group: key, accounts: pks.join(', '), ...metrics })))
  console.table(summary.evidence.map((row) => ({
    recipient: row.accountId, transfers: row.transfers.objects.map((t) => t.pk).join(', '), senders: row.senders.objects.map((s) => s.pk).join(', '),
  })))
  log('senderCount is computed from distinct senders in this scope; it is not a property stored on Account.')
  const selected = rt.filter(summary.aggregation, (row) => row.metrics.senderCount >= 2)
  trace('Filter aggregate rows: senderCount >= 2, retaining their accounts', { before: summary.aggregation.set }, selected.set)
  console.table(selected.values.map(({ key, pks, metrics }) => ({ group: key, accounts: pks.join(', '), ...metrics })))
  log('X and W meet the two-sender threshold. Choose X for this case because it is shared by all three origins.')
  log('X has four transfers from three senders, totalling 5,100,000 yen.')
  log('Context to verify:', account.properties.context)
  log('A shared payment provider could explain these transfers. Check their invoices and payment purposes.')

  h('6. Write: record a case for checking the payments')
  // Keep the original scope and evidence found by the explicit exploration.
  const request = {
    ...scope, accountId: account.pk, investigationId: 'CASE-X',
    transferIds: evidence.objects.map((t) => t.pk),
    reason: 'Request invoices and payment purposes for the common recipient; a legitimate explanation remains possible',
  }
  log('Selected account, scope and evidence:', request)
  log('Cases before execution:', rt.search('Investigation', { actor }).objects.length)
  log('The selection is unsaved. Execution rechecks each transfer against the current origin, timestamp and recipient links.')
  log('Create case:', rt.execute('openInvestigation', request, { actor }))
  log('No account was frozen. Temporal sequence does not identify the same funds uniquely.')

  h('7. Read: inspect the case and its eight evidence links')
  const saved = rt.get('Investigation', 'CASE-X', { actor })!
  log('Saved investigation:', saved)
  for (const link of ['accountInvestigations', 'investigationOrigins', 'investigationTransfers']) {
    trace(`Traverse ${link}: case → saved evidence`, { investigation: saved }, rt.traverse(saved, link, { actor }))
  }
  log('Next task: request the invoices and payment purposes for two transfers from A, one from B and one from C.')
  log('Document requests and review of the replies are outside this demo.')

  h('8. Audit log (applied AND rejected attempts)')
  for (const e of rt.auditLog()) {
    log(`  #${e.seq} ${e.status.padEnd(8)} ${e.action}(${e.target}) by ${e.actor}${e.error ? ` — ${e.error.code}` : ''}`)
  }
} finally {
  app.close()
}
