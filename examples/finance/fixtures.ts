/** A, B and C were supplied as investigation origins. No alert detector or real transactions. */
export function createFixtures() {
  return {
    accounts: [
      ...['A', 'B', 'C', 'D'].map((id) => ({ id, holder: `Example business ${id}`, context: id === 'D' ? 'Outside the selected origins' : 'Origin supplied for review; wrongdoing has not been established' })),
      { id: 'X', holder: 'Example shared payment service', context: 'Could be a legitimate common settlement provider; request invoice and purpose records' },
      { id: 'Y', holder: 'Example supplier Y', context: 'Supplier payment; verify its purpose' },
      { id: 'Z', holder: 'Example supplier Z', context: 'Supplier payment; verify its purpose' },
      { id: 'W', holder: 'Example service W', context: 'Receives from A and B, but not C in this scope' },
    ],
    transfers: [
      { id: 'T1a', sender_id: 'A', recipient_id: 'X', amount: 1000000, occurredAt: '2026-09-08T13:00:00+09:00' },
      { id: 'T1b', sender_id: 'A', recipient_id: 'X', amount: 700000, occurredAt: '2026-09-08T13:10:00+09:00' },
      { id: 'T2', sender_id: 'A', recipient_id: 'Y', amount: 100000, occurredAt: '2026-09-08T13:20:00+09:00' },
      { id: 'T3', sender_id: 'B', recipient_id: 'X', amount: 1500000, occurredAt: '2026-09-08T13:30:00+09:00' },
      { id: 'T4', sender_id: 'C', recipient_id: 'X', amount: 1900000, occurredAt: '2026-09-08T14:00:00+09:00' },
      { id: 'T5', sender_id: 'C', recipient_id: 'Z', amount: 200000, occurredAt: '2026-09-08T14:10:00+09:00' },
      { id: 'T6', sender_id: 'A', recipient_id: 'W', amount: 50000, occurredAt: '2026-09-08T14:20:00+09:00' },
      { id: 'T7', sender_id: 'B', recipient_id: 'W', amount: 60000, occurredAt: '2026-09-08T14:30:00+09:00' },
      // These must not inflate the selected period/origin totals.
      { id: 'T8', sender_id: 'A', recipient_id: 'X', amount: 9900000, occurredAt: '2026-09-07T13:00:00+09:00' },
      { id: 'T9', sender_id: 'D', recipient_id: 'X', amount: 8800000, occurredAt: '2026-09-08T13:00:00+09:00' },
      { id: 'T10', sender_id: 'A', recipient_id: 'X', amount: 7700000, occurredAt: '2026-09-08T11:00:00+09:00' },
    ],
  }
}
