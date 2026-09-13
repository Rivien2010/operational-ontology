**English** | [日本語](./README.ja.md)

# Finance: find shared recipients and retain the evidence

Run `pnpm demo:finance`. All accounts and transfers are fictional, and each run resets them. A, B and C are supplied investigation origins; a high deposit count alone is not treated as proof of wrongdoing. The example does not implement an alert detector or reproduce a vendor's interface.

```text
Sender Account ← Transfer → Recipient Account
```

`outgoing` and `incoming` are separate Account → Transfer links. Transfer is an object with an ID, timestamp and integer yen amount, so repeated transfers and their timing survive until the investigator chooses to pivot to accounts.

The demo follows outgoing transfers from each origin, filters September 8 afternoon, and pivots to recipients:

| Origin | Recipients |
| --- | --- |
| A | X, Y, W |
| B | X, W |
| C | X, Z |

Intersecting all three sets yields X. A model Function, `recipientSummary`, provides the complementary aggregate route:

| Recipient | Distinct senders | Transfers | Total yen |
| --- | --- | --- | --- |
| X | 3 | 4 | 5,100,000 |
| Y | 1 | 1 | 100,000 |
| Z | 1 | 1 | 200,000 |
| W | 2 | 2 | 110,000 |

A's 1,700,000 yen to X is split into two transfers. This makes transaction count and sender count visibly different. Additional records before the time window and from D must not inflate the totals. The model uses a half-open interval: `after <= occurredAt < before`.

```ts
const summary = rt.run('recipientSummary', {
  originIds: ['A', 'B', 'C'],
  after: '2026-09-08T12:00:00+09:00', before: '2026-09-09T00:00:00+09:00',
}, { actor })
const selected = rt.filter(summary.aggregation, [{ property: 'senderCount', op: 'gte', value: 2 }])
// selected.set contains Accounts X and W; values retain their metrics.
```

The Function returns an account aggregation, per-account evidence transfer/sender sets, and the input scope. Aggregation row `pks` identify recipient accounts. Evidence is kept separately at transfer grain. The caller can inspect the selected account's original records without confusing a deduplicated account count with an amount or a transaction count.

X's registered context offers a possible legitimate explanation: a shared payment provider. The investigator creates a case requesting invoice references and payment purposes. `openInvestigation` checks that every selected transfer still comes from the supplied origins, falls in the time window and reaches the selected recipient. It creates an ontology-owned case linked to its target, origins and evidence; a preview writes nothing. Source refresh preserves the case and links, but does not freeze source record contents as historical evidence snapshots.

## Scope and code

Shared recipients identify leads, not wrongdoing. The ordering of deposits and withdrawals does not uniquely establish that the same funds moved. No account is frozen, no source financial state is changed, and there is no multi-hop funds attribution, automated fraud score or causal inference.

Start with [`demo.ts`](./demo.ts), then [`ontology.ts`](./ontology.ts) for the summary Function and Action. `fixtures.ts` supplies ledger records, `integrate.ts` turns reference fields into links, and `runtime.ts` wires typed reads. The example assumes one writer and visibility of all relevant facts.

Run `pnpm mcp:finance`, or connect from the repository root:

```sh
claude --strict-mcp-config --mcp-config examples/finance/.mcp.json
```

Agents can combine generated filter/pivot/set tools with `recipient_summary`, pass its `aggregation` to `filter_account`, and then invoke `open_investigation` with the selected evidence. The Action checks evidence independently of caller-supplied metrics. See [IMPLEMENTATION.md](../../IMPLEMENTATION.md) for the common contracts.
