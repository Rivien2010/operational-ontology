import type { createFixtures } from './fixtures.js'

export function integrate(sources: ReturnType<typeof createFixtures>) {
  return {
    objects: {
      Account: sources.accounts.map((row) => ({ ...row })),
      Transfer: sources.transfers.map(({ sender_id, recipient_id, ...row }) => row),
    },
    links: {
      outgoing: sources.transfers.map((t): [string, string] => [t.sender_id, t.id]),
      incoming: sources.transfers.map((t): [string, string] => [t.recipient_id, t.id]),
    },
  }
}
