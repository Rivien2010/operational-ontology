/** Run: pnpm demo:finance. Integer amounts are yen. */
import { integrate } from './integrate.js'
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
  const eitherAB = rt.union(fromA, fromB)
  trace('Union A ∪ B: recipients reached from either origin', { A: fromA, B: fromB }, eitherAB)
  const anyRecipient = rt.union(eitherAB, fromC)
  trace('Union (A ∪ B) ∪ C: all recipients reached in this scope', { 'A ∪ B': eitherAB, C: fromC }, anyRecipient)
  const sharedAB = rt.intersect(fromA, fromB)
  trace('Intersect A ∩ B: recipients shared by A and B', { A: fromA, B: fromB }, sharedAB)
  const common = rt.intersect(sharedAB, fromC)
  trace('Intersect (A ∩ B) ∩ C: recipients shared by all three', { 'A ∩ B': sharedAB, C: fromC }, common)
  const notCommon = rt.subtract(anyRecipient, common)
  trace('Subtract: all recipients − recipients shared by all three', { all: anyRecipient, shared: common }, notCommon)
  log('W survives A ∩ B but drops out when intersecting with C. Y, W and Z remain in the difference set.')
  log('These operations compare Account IDs. They do not add amounts or count transfers.')

  h('4. Transform: compare sender counts, amounts and evidence')
  log('Function recipientSummary counts distinct senders and sums the retained evidence transfers for each recipient.')
  log('    params:', scope)
  const summary = rt.call('recipientSummary', scope, { actor })
  showObjects('recipient accounts', summary.aggregation.set)
  console.table(summary.aggregation.values.map(({ key, pks, metrics }) => ({ group: key, accounts: pks.join(', '), ...metrics })))
  const selected = rt.filter(summary.aggregation, (row) => row.metrics.senderCount >= 2)
  trace('Filter aggregate rows: senderCount >= 2, retaining their accounts', { before: summary.aggregation.set }, selected.set)
  console.table(selected.values.map(({ key, pks, metrics }) => ({ group: key, accounts: pks.join(', '), ...metrics })))
  log('X and W meet the two-sender threshold. Choose X for this case because it is shared by all three origins.')
  log('X has four transfers from three senders, totalling 5,100,000 yen.')
  const account = common.objects[0]
  const evidence = summary.evidence.find((e) => e.accountId === account.pk)!
  log('Context to verify:', account.properties.context)
  showObjects('evidence transfers for X', evidence.transfers)
  showObjects('distinct senders for X', evidence.senders)
  console.table(evidence.transfers.objects.map(({ pk, properties }) => ({ transfer: pk, occurredAt: properties.occurredAt, yen: properties.amount })))

  h('5. Write: record a case for checking the payments')
  const request = {
    ...summary.scope, accountId: account.pk, investigationId: 'CASE-X',
    transferIds: evidence.transfers.objects.map((t) => t.pk),
    reason: 'Request invoices and payment purposes for the common recipient; a legitimate explanation remains possible',
  }
  log('Selected account, scope and evidence:', request)
  log('Create case:', rt.execute('openInvestigation', request, { actor }))
  log('No account was frozen. Temporal sequence does not identify the same funds uniquely.')

  h('6. Re-index: the case and its evidence links survive')
  rt.load(integrate(app.sources))
  const saved = rt.get('Investigation', 'CASE-X', { actor })!
  const savedTransfers = rt.traverse(saved, 'investigationTransfers', { actor })
  trace('Traverse investigationTransfers (forward): Investigation → Transfer', { investigation: saved }, savedTransfers)
  log('Evidence after source refresh:', savedTransfers)

  h('7. Audit log (applied AND rejected attempts)')
  for (const e of rt.auditLog()) {
    log(`  #${e.seq} ${e.status.padEnd(8)} ${e.action}(${e.target}) by ${e.actor}${e.error ? ` — ${e.error.code}` : ''}`)
  }
} finally {
  app.close()
}
