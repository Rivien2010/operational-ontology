[English](./README.md) | **日本語**

# 金融：共通の受取先を探し、根拠を残す

`pnpm demo:finance` で実行します。すべて架空の口座・取引で、毎回初期状態に戻ります。A・B・C は調査の起点として与えられた口座で、入金件数が多いだけで不正と判定してはいません。アラート検知器や、特定製品の画面を再現する例ではありません。

```text
送金元 Account ← Transfer → 受取先 Account
```

`outgoing` と `incoming` は別々の Account → Transfer リンクです。Transfer は ID・日時・整数の円金額を持つオブジェクトなので、口座へ pivot する段階までは複数回の送金と時刻を保持できます。

各起点の出金取引へ進み、9月8日の午後で filter し、受取口座へ pivot します。

| 起点 | 受取先 |
| --- | --- |
| A | X・Y・W |
| B | X・W |
| C | X・Z |

3集合の積集合は X です。モデルの Function `recipientSummary` では、集計を使う別の経路も示します。

| 受取先 | 異なる送金元数 | 取引件数 | 合計金額（円） |
| --- | --- | --- | --- |
| X | 3 | 4 | 5,100,000 |
| Y | 1 | 1 | 100,000 |
| Z | 1 | 1 | 200,000 |
| W | 2 | 2 | 110,000 |

A から X への170万円を2件の取引に分け、取引件数と送金元数が異なることを示します。期間より前の取引や D からの取引も置き、それらが合計に混ざらないことを確かめます。期間は `after <= occurredAt < before` の半開区間です。

```ts
const summary = rt.run('recipientSummary', {
  originIds: ['A', 'B', 'C'],
  after: '2026-09-08T12:00:00+09:00', before: '2026-09-09T00:00:00+09:00',
}, { actor })
const selected = rt.filter(summary.aggregation, [{ property: 'senderCount', op: 'gte', value: 2 }])
// selected.set は口座 X・W。values はそれぞれの集計値を保持する。
```

Function は口座の集計、口座ごとの根拠取引・送金元集合、入力した調査範囲を返します。集計行の `pks` は受取口座の ID です。根拠は取引の粒度で別に保持します。利用者は、重複排除した口座数と金額・取引件数を混同せず、選んだ口座の元記録を確認できます。

X の登録情報には、共通の決済事業者という正当な説明の可能性があります。担当者は、請求書と送金目的を確認するケースを作成します。`openInvestigation` は選んだ全取引について、現在も指定した起点からの送金で、対象期間内にあり、選択した受取先へ到達することを検査します。ontology-owned なケースと対象口座・起点口座・根拠取引へのリンクを作り、preview では何も保存しません。ソースの再読み込み後もケースとリンクを保持しますが、ソースレコードの内容を過去のまま固定した根拠スナップショットにはしません。

## 範囲とコード

共通する受取先は調査の手掛かりであり、不正の判定ではありません。入出金が時系列で続いても、同じ資金が動いたとは一意に特定できません。口座凍結や源泉の金融状態の変更、多段階の資金帰属の特定、自動不正スコア、因果推論は行いません。

[`demo.ts`](./demo.ts) から読み、集計 Function と Action は [`ontology.ts`](./ontology.ts) で確認できます。`fixtures.ts` が台帳のデータを供給し、`integrate.ts` が参照をリンクに変え、`runtime.ts` が型付きの読み取りを接続します。単一の書き込み元と、関係する全事実の可視性を前提にします。

`pnpm mcp:finance` で起動するか、リポジトリのルートから次で接続できます。

```sh
claude --strict-mcp-config --mcp-config examples/finance/.mcp.json
```

エージェントは filter・pivot・集合演算と `recipient_summary` を組み合わせ、返された `aggregation` を `filter_account` に渡し、選んだ根拠で `open_investigation` を実行できます。Action は呼び出し元が渡す集計値とは独立して根拠を検査します。共通の契約は [IMPLEMENTATION.ja.md](../../IMPLEMENTATION.ja.md) にあります。
