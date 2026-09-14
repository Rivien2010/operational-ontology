import { z } from 'zod'
import {
  aggregationResult, create, defineAction, defineFunction, defineLink, defineObject, defineOntology, link, objectSet, reject,
  type Runtime,
} from '../../src/core.js'

const objects = {
  Account: defineObject({
    primaryKey: 'id', source: 'account register',
    properties: { id: z.string(), holder: z.string(), context: z.string() },
  }),
  Transfer: defineObject({
    primaryKey: 'id', source: 'payment ledger',
    properties: { id: z.string(), occurredAt: z.iso.datetime({ offset: true }), amount: z.number().int().positive() },
    description: 'One transfer, with an integer amount in yen. Several transfers may connect the same accounts.',
  }),
  Investigation: defineObject({
    primaryKey: 'id', owned: true,
    properties: { id: z.string(), after: z.iso.datetime({ offset: true }), before: z.iso.datetime({ offset: true }), reason: z.string() },
  }),
}
const schema = defineOntology({
  name: 'finance', objects,
  links: {
    outgoing: defineLink({ from: 'Account', to: 'Transfer', kind: 'one-to-many', via: 'payment.sender_id' }),
    incoming: defineLink({ from: 'Account', to: 'Transfer', kind: 'one-to-many', via: 'payment.recipient_id' }),
    accountInvestigations: defineLink({ from: 'Account', to: 'Investigation', kind: 'one-to-many', owned: true }),
    investigationOrigins: defineLink({ from: 'Investigation', to: 'Account', kind: 'many-to-many', owned: true }),
    investigationTransfers: defineLink({ from: 'Investigation', to: 'Transfer', kind: 'many-to-many', owned: true }),
  },
  actions: {},
})
const scope = {
  originIds: z.array(z.string()).min(1),
  after: z.iso.datetime({ offset: true }), before: z.iso.datetime({ offset: true }),
}
type Scope = z.output<z.ZodObject<typeof scope>>
type Read = Pick<Runtime<typeof schema>, 'get' | 'pivot' | 'traverse' | 'filter' | 'intersect'>

/** Link-based summaries belong to the model; aggregation in the runtime stays small. */
export function createFinanceOntology(read: () => Read) {
  function transfersInScope(params: Scope, actor: string) {
    if (Date.parse(params.after) >= Date.parse(params.before)) return { error: reject('INVALID_WINDOW', 'after must precede before') }
    const accounts = params.originIds.map((id) => read().get('Account', id, { actor }))
    if (accounts.some((a) => !a)) return { error: reject('ORIGIN_MISSING', 'An origin account is missing or hidden') }
    const origins = objectSet('Account', accounts.filter((a) => a !== undefined))
    const transfers = read().filter(read().pivot(origins, 'outgoing', { actor }), [
      { property: 'occurredAt', op: 'gte', value: params.after },
      { property: 'occurredAt', op: 'lt', value: params.before },
    ])
    return { origins, transfers }
  }
  return defineOntology({
    ...schema,
    functions: {
      recipientSummary: defineFunction({
        description: 'Summarize recipients in the supplied origin/time scope, with distinct sender counts, yen totals and evidence. Shared recipients are leads, not proof of wrongdoing.',
        params: scope,
        run: ({ params, actor }) => {
          const scoped = transfersInScope(params, actor)
          if (scoped.error) throw new Error(scoped.error.message)
          const { origins, transfers } = scoped
          const recipients = read().pivot(transfers, 'incoming', { actor })
          const evidence = recipients.objects.map((account) => {
            const related = read().intersect(transfers, read().traverse(account, 'incoming', { actor }))
            return { accountId: account.pk, transfers: related, senders: read().pivot(related, 'outgoing', { actor }) }
          })
          const aggregation = aggregationResult(recipients, { senderCount: 'number', transactionCount: 'number', totalAmount: 'number' },
            evidence.map((row) => ({
              key: row.accountId, pks: [row.accountId], senderCount: row.senders.objects.length,
              transactionCount: row.transfers.objects.length,
              totalAmount: row.transfers.objects.reduce((sum, t) => sum + t.properties.amount, 0),
            })))
          return { aggregation, evidence, scope: { ...params, originIds: origins.objects.map((a) => a.pk) } }
        },
      }),
    },
    actions: {
      openInvestigation: defineAction(objects, {
        description: 'Create an investigation case with its origin/time scope and selected evidence transfers. Does not freeze or modify an account.',
        object: 'Account', targetParam: 'accountId',
        params: { ...scope, accountId: z.string(), investigationId: z.string().min(1), transferIds: z.array(z.string()).min(1), reason: z.string().min(1) },
        preconditions: [({ object, params, actor }) => {
          if (new Set(params.transferIds).size !== params.transferIds.length) return reject('DUPLICATE_EVIDENCE', 'Choose each transfer once')
          // Re-read both the scope and recipient relationship when the Action runs.
          const scoped = transfersInScope(params, actor)
          if (scoped.error) return scoped.error
          const evidence = read().intersect(scoped.transfers, read().traverse(object, 'incoming', { actor }))
          if (params.transferIds.some((id) => !evidence.objects.some((t) => t.pk === id))) {
            return reject('INVALID_EVIDENCE', 'Every transfer must be in the chosen origin/time scope and end at this account')
          }
        }],
        effects: ({ object, params }) => [
          create('Investigation', params.investigationId, { id: params.investigationId, after: params.after, before: params.before, reason: params.reason }),
          link('accountInvestigations', object.pk, params.investigationId),
          ...[...new Set(params.originIds)].map((id) => link('investigationOrigins', params.investigationId, id)),
          ...params.transferIds.map((id) => link('investigationTransfers', params.investigationId, id)),
        ],
      }),
    },
  })
}
export type Finance = ReturnType<typeof createFinanceOntology>
