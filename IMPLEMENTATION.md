**English** | [日本語](./IMPLEMENTATION.ja.md)

# Implementation notes

The [README](./README.md) introduces the pattern, demo, and scope. This document describes this implementation's API and runtime behavior. Shared runtime, type-level, and MCP checks are in [`tests/`](./tests/); scenario tests are in `examples/*/scenario.test.ts`. `pnpm test` runs both.

An action execution refusal returns `{ ok: false, error: { code, message } }` and is audited. Preview uses the same result shape without auditing. Programming and storage errors may throw; the write path records them as described below. Query errors are exceptions rather than action refusals.

## Code organization

The public entry point remains `Runtime`; the implementation follows the responsibilities below without introducing a query class or storage interface hierarchy.

| File | Responsibility |
| --- | --- |
| `model.ts` | Definition helpers, instance shapes and edit plans. |
| `core.ts` | Actor-scoped reads, the public query methods, `run` / `preview`, and the Action gate. |
| `query.ts` | Pure operations on evaluated sets and aggregations; structured conditions shared with MCP. |
| `store.ts` | Concrete SQLite storage, indexing, integrity checks, edits and atomic local audit commits. |
| `mcp.ts` | Generate tools from the model and adapt inputs to the same runtime operations. |

## Instances and traversal

Runtime object values are read snapshots shaped as `{ type, pk, properties }`. Identity is `(type, pk)`; `pk` comes from the declared primary key, even when that property is not named `id`. Business properties named `type`, `pk`, or `properties` remain nested without collisions. Mutating a snapshot does not write the store.

`get` returns an instance or `undefined`; `search`, `traverse` and `pivot` return an `ObjectSet`. Visibility, object-filter callbacks, action contexts and `meta.target` receive instances. `modify` changes, `create` data and indexing rows use business properties directly. `defineAction(objects, …)` derives `ctx.object` from its object name and `ctx.params` from its parameter schema. `modify(instance, changes)` describes an edit without applying it. All edit payloads are checked at runtime.

With the orders example, either end of a link can be the source:

```ts
const hq = { actor: 'user:hq' }
const customer = rt.get('Customer', 'N-C01', hq)!
const orders = rt.traverse(customer, 'customerOrders', hq) // ObjectSet, type === 'Order'
const customers = rt.traverse(orders.objects[0], 'customerOrders', hq) // ObjectSet, type === 'Customer'
console.log(orders.objects[0].properties.status)
```

This branch simplifies TypeScript contracts to make the implementation easier to read. Input names are strings, operation params and edit properties are plain records, and conditions have a common shape. The runtime checks model-specific names, values and relationships. The editor does not guide callers from an object to its links, directions or valid conditions.

Basic data shapes, readonly identities and model-author callback types remain. A small result lookup also remains: a literal name in `get`, `search` or `run` determines its result type. Keep the inferred model definition for this lookup; an explicit `OntologyDef` annotation erases its specific schemas. A dynamic object name returns common instances with `unknown` property values; a dynamic operation name returns `unknown`. `traverse`, `pivot` and set algebra return the common `ObjectSet` shape. Business code that needs concrete properties after traversal must narrow or assert their types; an assertion does not validate a value.

`traverse(source, linkName, { actor, direction? })` accepts a full instance, with no primary-key-only or reference-only overload. The link definition determines direction.

`direction` is optional in the TypeScript interface. The runtime checks whether it can be omitted and rejects an impossible direction or a missing choice for a same-type link:

| Source type matches | Direction | Runtime destination |
| --- | --- | --- |
| `from` only | `forward`, optional | `to` |
| `to` only | `reverse`, optional | `from` |
| Both ends | `forward` or `reverse`, required | The same object type |
| Neither end | Invalid link for this source | — |

For an `Employee → Employee` link defined from manager to subordinate, `forward` gets subordinates and `reverse` gets managers. Only the existing link name is needed; there are no directional aliases.

The rule depends on the declared types, not the stored edges. Traversal always returns a set, including for one-to-many reverse traversal; its `type` tag records the destination. Traversal re-reads `(type, pk)` under the caller's actor and checks visibility at both ends. Supplied properties are ignored for these checks. Missing or hidden sources yield an empty set retaining the destination type. Invalid source shape, link or direction throws.

`pivot(set, linkName, { actor, direction? })` applies the same rules to each origin and deduplicates the destinations. It validates the link and direction even when the input set is empty. Returning to a previously visited type retrieves the related instances, not the original or complete set of that type.

MCP reads serialize the same shape. Traversal tools take `{ source: { type, pk, properties }, direction? }`, with direction required in the schema for same-type links. These generated schemas still expose model-specific choices to agents independently of TypeScript's simpler interfaces. Stored rows and audit edit payloads keep their existing format.

## Object sets, filters and aggregation

An `ObjectSet<O>` is `{ type, objects }`: one object type and an array of its instances, already evaluated. Empty sets retain the type. Identity is `(type, pk)`; duplicates keep the first occurrence. `objectSet(type, objects)` constructs and validates this shape. Its tag and array are readonly in TypeScript; agreement between the tag and every member is checked at runtime. The optional element type `O` describes properties but does not prove this agreement. This is not a deep freeze: object properties remain read snapshots, and set operations may share those instance values.

`filter`, `union`, `intersect`, `subtract` and `aggregate` operate on those snapshots without an actor or store read. They return new containers, do not change the store and are not audited. Set algebra requires the same object type. Union preserves left members followed by unseen right members; intersection and subtraction preserve left order and values. No freshness comparison is attempted: when identities overlap, the left snapshot wins. Re-run the read or Function to obtain current state.

```ts
const orders = rt.search('Order', { actor: 'user:hq' })
const pending = rt.filter(orders, [{ property: 'status', op: 'eq', value: 'pending' }])
const large = rt.filter(orders, (order) => order.properties.total >= 10000)
const either = rt.union(pending, large)       // OR
const both = rt.intersect(pending, large)   // AND between sets
const remaining = rt.subtract(orders, both)
```

Structured conditions are an ANDed array of `{ property, op, value }`. TypeScript checks the clause shape and the fixed operator vocabulary. Model-specific field names, allowed operators and values are checked at runtime, including against an empty set, and appear in generated MCP schemas. `search` also accepts them in its optional `filter` option. The legacy `{ status: 'pending' }` equality shorthand is removed. Callbacks are synchronous TypeScript predicates; they must not cause side effects and cannot be sent over MCP.

| Field | Operators |
| --- | --- |
| String / string enum | `eq`, `ne`, `in`, `contains`; case-sensitive. |
| Number | `eq`, `ne`, `in`, `gt`, `gte`, `lt`, `lte`. |
| Boolean | `eq`, `ne`, `in`. |
| ISO date / datetime | `eq`, `ne`, `in`, `gt`, `gte`, `lt`, `lte`. |

Declare dates with `z.iso.date()` or `z.iso.datetime({ offset: true })` so runtime validation and MCP schemas distinguish dates from ordinary strings. Datetimes are compared as instants, including offsets; dates are calendar dates interpreted at UTC midnight for comparison. They remain JSON strings in storage. Numeric values are not coerced from strings. Optional/nullable/default wrappers around supported scalar schemas are recognized, but comparing a null/missing value, grouping by one, or summing one is outside the query contract and throws; no implicit zero is used. Nested properties, array predicates and mixed-type schemas are not part of the structured condition language. OR uses union; NOT uses subtraction from an explicit base set.

`aggregate(set, { groupBy, sum? })` groups by one scalar property, always computes `count`, and optionally sums one numeric property. Its result has three parts:

- `set`: the input objects belonging to its groups.
- `columns`: numeric metric names and their runtime types, such as `{ count: 'number', sum: 'number' }`.
- `values`: rows containing a scalar `key`, member `pks`, and the declared numeric metrics.

```ts
const grouped = rt.aggregate(pending, { groupBy: 'status', sum: 'total' })
const selected = rt.filter(grouped, [{ property: 'sum', op: 'gte', value: 10000 }])
console.log(selected.values) // Selected rows, with their original metrics
const targets = selected.set // Order objects belonging to those rows
```

There is no separate `having` method. Filtering an aggregation selects rows by numeric metrics and retains the union of their corresponding objects; it does not recompute metrics. To filter object properties, use `.set`, then aggregate again explicitly if needed. Filtering to zero rows keeps an empty tagged set and the column declarations. Grouping by a property does not pivot to the type that property might refer to.

Model Functions can return the same `AggregationResult<O>` shape for domain summaries. For example, finance returns recipient **accounts** with `senderCount`, `transactionCount` and `totalAmount`, computed from **transfers**. `aggregationResult(set, columns, values)` validates finite numeric metrics, unique group keys and member references, and forms the corresponding set. Column declarations are runtime data used by filtering and MCP validation. TypeScript knows each row's `key` and `pks`; arbitrary metric access yields `unknown` and needs narrowing in a callback. Structured metric conditions use the same clause shape as object filters. Each row's `pks` refer to its target set, not automatically to its evidence records. Evidence sets live alongside the aggregation in the Function result; callers select the evidence for the chosen target. Automatic path history, recursive traversal, arbitrary transforms, joins and a general aggregation language are not implemented.

## MCP query inputs

The model generates `search_<type>`, `get_<type>`, `filter_<type>`, `union_<type>`, `intersect_<type>`, `subtract_<type>`, `aggregate_<type>`, plus `traverse_<link>` and `pivot_<link>`.

| Tool | Input |
| --- | --- |
| `search_<type>` | `{ where?: conditions }` |
| `get_<type>` | `{ <primaryKey>: value }` |
| `filter_<type>` | `{ source: { pks: [...] }, where: conditions }`, or a returned aggregation as `source`. |
| `union/intersect/subtract_<type>` | `{ left: pks, right: pks }` |
| `aggregate_<type>` | `{ pks, group_by, sum?, where? }` |
| `traverse_<link>` | `{ source: { type, pk, properties }, direction? }` |
| `pivot_<link>` | `{ source: { type, pks }, direction? }` |

Object collections serialize as `{ type, objects }`. Inputs identified by primary key are reloaded under the session actor; supplied snapshots never grant visibility. Conditions use the same definitions and evaluator as TypeScript. No arbitrary code or SQL is accepted.

For an aggregation input, `filter_<type>` validates the declared numeric columns and member correspondence, reloads target objects, and drops a whole group if any target member is missing or hidden. Supplied metrics remain caller-supplied analysis snapshots: the server neither recomputes them nor certifies their provenance or freshness. Actions must check their own current inputs and evidence, as the examples do. An aggregation's `.set` is the object input for the next exploration step; an outer Function result with extra evidence is not itself an aggregation.

## Visibility and caller identity

`get`, `search`, `traverse` and `pivot` carry an `actor`. Pure operations on already obtained sets do not reapply visibility; sharing such values with another caller is the application’s responsibility. An object type's optional `visibility` predicate filters reads and action targets. A hidden object behaves like a missing one: `get` returns `undefined`, traversal returns no hidden rows, and running an action refuses a hidden target with `TARGET_NOT_FOUND`.

Authentication establishes the actor's identity outside the runtime. When an implementation provides authorization, policies belong on object types and actions so every consumer is subject to the same constraints. That placement is a separate design choice from the mechanism used to implement it, such as groups, attributes, or a policy language. Preconditions check business validity. Separating permission from validity is recommended; implementing them as separate mechanisms is not a condition of the pattern.

This reference implementation demonstrates where model-attached policies live and how they act. How much authorization to provide is an implementation choice; here, `visibility` is optional and declared to default to fail-open: visible to everyone. The actor is a self-declared string; the runtime provides neither authentication nor a general action-permission system. Making visibility declarations mandatory alone cannot protect access based on verified user identities. Audit reads remain an unscoped administrative view, without visibility filtering.

Over MCP stdio, callers share one actor. `OO_AGENT=<name> pnpm mcp` labels it as `agent:<name>`; this is not authentication. The server generates read tools and action tools from the model and passes calls through the runtime. Action refusals become MCP errors containing `{ error: { code, message } }`; caught runtime exceptions use the `INTERNAL` code. For local store access, see [Transaction ownership](#transaction-ownership).

## Running named operations

`run(name, params, { actor })` accepts a string name and a params record. The runtime looks up the Action or Function and validates its input schema. A literal name retains result inference: Actions return `ActionResult`, while Functions return their implementation's result, including a Promise for an async function. Wrong parameter names or values compile but fail runtime validation. `defineOntology()` and runtime construction reject names shared by an Action and a Function. An unknown operation name throws before dispatch and creates no audit entry.

This replaces `execute()` and the separate Function `call()` entry point; neither remains as an alias. Dynamic callers that previously received an audited `UNKNOWN_ACTION` refusal from `execute()` now receive an exception for an unknown name. Refusals for known Actions remain audited.

## Executing actions

An action definition must include `preconditions`, using `[]` when there are none. Because business rules at the action govern the write path, having no conditions must also be an explicit decision by the model's author.

`run(actionName, params, { actor })` follows this order:

1. Validate params and load the target under the actor's visibility policy.
2. Evaluate preconditions.
3. Run the effects function to obtain an edit plan.
4. Dry-run the whole plan through the commit's own code, then roll it back.
5. Check the plan against the ownership declarations.
6. Write back a nonempty source-backed plan through the adapter.
7. Commit the local edits and audit entry in one transaction.

Effects describe changes as data and must be pure. `modify` changes properties, `create` creates an ontology-owned object, and `link` / `unlink` change relationships. The gate checks schemas, object existence, and cardinality before the adapter runs. A create-and-link action such as `addOrderNote` commits its local plan atomically. These edits change instances; model definitions are code reviewed and versioned in git.

## Preview and model-defined functions

`preview(actionName, params, { actor })` shares the execution gate through step 5 and checks that a required write-back adapter exists. It returns `{ ok: true, edits }` or the same local refusal as execution. Its dry run rolls back; it performs no write-back, commits no edits, and records no audit entry, including on refusals and exceptions. Preconditions and effects must not perform side effects. Preview does not reserve resources or ask the source to accept a write. Running the Action re-evaluates current state and the adapter may still refuse a stale source write.

Models may register named reads in `functions` using `defineFunction({ description, params, run })`. For a Function name, `rt.run(name, params, { actor })` validates the parameter schema and calls `run({ params, actor })`. The model author's callback receives schema-derived params; callers supply a plain record and receive the implementation's result type when using a literal name. Functions return their values directly. Invalid params, unknown names, and implementation errors throw; calls do not enter the action audit log. MCP generates a tool from each definition, with the same input schema and session actor, and marks it with `readOnlyHint`. It awaits asynchronous results and reports caught exceptions as `INTERNAL` errors.

For example, `rt.run('customerImpact', { lotIds: ['L1'] }, { actor })` returns a customer aggregation and its shipped-line evidence. The factory model owns the search procedure; the caller supplies the lots and uses the result. Functions can also implement domain reads without an associated Action.

Function implementations must use the caller's actor for their reads and must not perform writes or other side effects. This is a model-author contract, like pure preconditions and effects, not an enforced sandbox. The examples inject a getter for typed read methods in `runtime.ts`; rules and functions use those methods after runtime construction. No new read API is added to `ActionCtx`.

Hospital candidate searches cannot preview the final allocation while a bed or nurse is still unspecified. Its model shares ordinary evaluation functions between `bedSearch`, `nurseSearch` and the final Action. Candidate Functions return `{ set, assessments }`, where every assessment contains an object and an array of `{ code, message }` reasons. There is no partial-preview API or new generic rule-engine interface. Action execution still returns the first refusal through the existing gate.

Running several Actions creates independent attempts with separate audit entries. A single action can accept an array parameter and validate and commit its whole local plan atomically, as `createContactTask` does for its evidence lines. Separate successful previews do not reserve shared resources: hospital plans for P1 and P4 can each pass preview, but applying one consumes the bed and nurse capacity and causes the other to be refused. In the three investigation examples, customer-contact tasks, provisional allocations and investigation cases are ontology-owned objects linked to source facts. They survive re-indexing; they do not imply that a message was sent, a source admission was changed, or an account was frozen. Stored evidence links retain record identities, not immutable copies of source record contents.

## The authority line, checked

The model declares ownership in two places: `owned` on object types and links marks ontology-owned state, and `writeback: true` on an action marks its changes source-backed. The runtime classifies every edit plan against the `owned` declarations and refuses any plan that contradicts its action's declaration:

| the plan | action declares `writeback` | result |
| --- | --- | --- |
| changes source-backed state | no | refused: **`UNDECLARED_SOURCE_WRITE`** |
| changes only ontology-owned state | yes | refused: **`MISDECLARED_WRITEBACK`** |
| changes both kinds, within one edit or across edits | either | refused: **`MIXED_AUTHORITY`** |
| creates an object of a source-backed type | either | refused: **`SOURCE_CREATE_UNSUPPORTED`** |

The reasoning, row by row. An undeclared source write would be a local change to source-owned data that never reaches the source — exactly what property 4 forbids. A misdeclared write-back contains nothing that belongs to a source. A mixed plan is refused because this implementation routes plans whole, so an action must sit on one side of the line; split the action if it needs both. Per-edit routing is unsupported. Creating a row at the source is real — write-back could carry it — but this implementation does not demonstrate it, so it refuses rather than half-supports; creation is limited to ontology-owned types.

An empty plan touches neither side of the line: no adapter call, only the audit entry is committed. An action that declares write-back but has no adapter configured is refused with **`NO_WRITEBACK_ADAPTER`**.

Validity is checked before authority. The whole plan is dry-run through the commit's own code first, so a plan the store would refuse is **`INVALID_EDITS`** even if it also crosses the authority line.

The four declared answers themselves are enumerable at runtime as `Runtime.declarations`, pinned by a test.

## Failure semantics in detail

The declared ordering is write-back first: the adapter runs before the local commit. If the system of record refuses, nothing changes in the ontology. The remaining risk is the reverse failure — the adapter succeeded and the local commit failed — and when it happens, the systems have diverged. Three mechanisms bound that risk.

**Nothing invalid crosses the boundary.** Before the adapter runs, the whole edit plan is applied inside a transaction that is always rolled back: a dry run using the commit's own code, not a second validator that could drift out of sync. Every violation the store can detect — schema, cardinality, link endpoints — is refused before anything reaches a system of record. The adapter also receives its inputs up front, as its own copies: the validated plan, and the target object as the runtime loaded it (`meta.target`). It never needs to read the ontology store.

**The audit log records both failure directions.** A **`WRITEBACK_FAILED`** refusal records the full plan the adapter saw — the adapter may have partially applied it before throwing, since source-side atomicity is the adapter's contract, not this runtime's. The reverse failure is audited as **`COMMIT_FAILED`**, plan included: after a write-back-first action, those edits are what already reached the source. Both entries are raw material for reconciliation.

**"Every action attempt is audited" has a stated limit.** It covers calls to known Actions admitted to the write gate and observed to completion. Reads, previews, unknown operation names, and calls refused because of a caller-opened transaction do not enter this log. If the process dies between the source update and the local commit, both the edit and its audit entry are lost. Closing that window would take a persisted pending-invocation record, which this implementation does not have.

A crash inside the write path is audited as **`EXECUTION_CRASHED`** — a storage fault, or model code (a visibility predicate, a precondition, an effects function) that threw. The error then propagates to the caller.

The audit write itself must not be a failure point. Params whose values would change when serialized to JSON and back are refused as **`INVALID_PARAMS`** before the model runs. Anything the log still cannot encode is recorded as a `$unserializable` placeholder: a lossy audit entry is better than a missing one.

The audit log sits outside the object graph because its contract differs from that of ordinary business objects. It records refusals and crashes that commit no business edits, retains a record using placeholders for values it cannot encode, and is appended to by the runtime without going through an action. Treating entries as ordinary objects would require exceptions to schema-based refusal and action-gated writes, so this implementation exposes them through a separate administrative view.

**Preconditions and freshness.** Rules see the indexed snapshot plus applied local edits. The source may have changed since indexing; the runtime does not re-check source invariants itself. The adapter must handle that boundary. The demo's [ERP adapter](./examples/orders/erp-adapter.ts) uses a guarded `UPDATE`, allowing the ERP to refuse a cancellation after an order has shipped.

**Concurrency.** Action execution and the adapter interface are synchronous. The example assumes a single writer, so no other action interleaves between preflight and commit. An asynchronous adapter or multiple writers would require an explicit concurrency mechanism; neither is implemented here.

**Retries.** There are no idempotency keys or deduplication. `cancelOrder` refuses an already-cancelled order through its own precondition, but that does not guarantee every action or external side effect is safe to retry. A caller-supplied note ID can prevent duplicate local creation; it is not a general retry protocol.

An action instance is identified by its occurrence, not its arguments. Two calls with the same params are separate attempts, each subject to auditing. Adding an invocation ID to params can correlate attempts, but deduplication also requires deciding how checking and recording that ID coordinates with executing side effects. Recording the ID in the log alone does not prevent duplicate execution.

## Transaction ownership

Rollback has three areas of responsibility. Source dataset versioning and rollback belong to the data platform. This runtime applies an action's local edits and audit entry in one SQLite transaction. Consistency across write-back to external systems is a separate design concern: a local rollback cannot undo changes already delivered to a source. This implementation declares its ordering and failure behavior in the [preceding section](#failure-semantics-in-detail).

One rule is enforced: callers cannot wrap the runtime. Running an Action and calling `load()` are refused inside a caller-opened transaction, because inside one, "committed" would really mean "until the caller rolls the savepoint back" — an applied-and-audited action could be undone after the runtime reported success. `preview()` refuses the same context to keep validation at the same transaction boundary as execution. This is an atomicity guarantee, not an intrusion defense.

The rest of the boundary is declared, not defended. The runtime is an in-process library: any code that holds the database handle — the caller, a rule, the write-back adapter — can bypass the action gate with a direct `UPDATE`, and no in-process check can prevent that. The contract is therefore: rules and the adapter must not touch the ontology store. The adapter has no reason to — it receives its own copies of the edit plan and the target object, and speaks only to the systems of record.

An earlier version detected one observable slice of violations — a transaction left open on the store — and v0.2 removed the detector: a check that catches one intrusion shape but misses the simplest one (a direct autocommit `UPDATE`) looks like a defense without being one. A deployment that needs an enforced boundary should put the runtime behind a process boundary, with no direct database access for consumers. The bundled MCP server is exactly that shape.

## The storable boundary

The store keeps JSON, so every stored value must survive JSON serialization and deserialization unchanged. A row containing a value that would come back changed or dropped — a class instance, a `Date`, `NaN`, a `Map`, `undefined` at any depth — is refused at every write, whether it arrives through an action or through `load()`. The same check applies to a declared default for an `owned` property (at definition time) and to action params (at the entry point; see the audit note above).

One obligation is declared rather than checked: property schemas must validate, not transform. The runtime feeds stored values back through the same schema on later writes, so a transforming schema (`z.coerce.date()`, `.transform(…)`) would refuse or silently rewrite its own output on the next pass. An earlier version enforced this with a per-write fixed-point check (validate, re-validate the output, require identity); v0.2 states it as the model author's contract instead.

## Re-indexing vs edits

Snapshot semantics, per loaded type: replace the base, reapply the edit layer. The rules, each stated as its outcome:

- **Refused: a snapshot row that supplies ontology-owned state.** Rows that set ontology-owned properties, rows of ontology-owned types, and instances of ontology-owned links are all refused — the source owns none of them.
- **Kept: edits to ontology-owned properties.** They live in an overlay keyed by (type, pk); after a re-index, the overlay's current patch is reapplied over the fresh base. An edit set back to its declared default is removed from the overlay — clearing an edit also clears the obligation to preserve it. (The comparison is structural, so key order cannot fake or hide "back at default".)
- **Kept in place: ontology-owned types and links.** `load()` refuses to touch them, so they need no overlay.
- **Refused whole: a load that would orphan an edit.** If a base row disappears while it still carries ontology-owned edits, the entire load is refused and the previous state stands. What happens to that state is a reconciliation decision, and the runtime does not make reconciliation decisions silently: clear the edit or restore the row, then re-load. Clearing the edit is itself an action, so even reconciliation stays inside the write gate.
- **Refused: an overlay key the model no longer owns.** If the model stops declaring a property ontology-owned while an overlay patch still carries it, the load is refused — that state's fate belongs to explicit schema evolution, not to a refresh.
- **Refused: a partial snapshot that breaks constraints.** If surviving state on un-loaded types would violate the model's constraints, the whole re-index is refused and rolled back.

## Current limits

These limits describe the current implementation:

- An edit plan cannot mix source-backed and ontology-owned changes; creation is limited to ontology-owned types, as shown in the [authority checks](#the-authority-line-checked).
- There are no deletes, link properties, or composite keys. The orders demo leaves line quantities in the data layer; the factory model represents shipment lines as objects to aggregate affected quantities.
- `modify`, `create`, `link`, and `unlink` payloads are checked at runtime; their TypeScript types are not derived from the model. Nested properties follow their Zod schemas and are not made strict by the runtime.
- Queries use the local SQLite snapshot, with no pagination or result cap. Saved/lazy queries, automatic path history, recursive exploration, federation and runtime schema evolution are outside the implemented API. The audit log is a separate administrative view rather than an object in the graph.

The API has changed since v0.3: object reads and `meta.target` use `{ type, pk, properties }`; traversal takes an instance first; actions use `defineAction(objects, definition)`; modifications use `modify(instance, changes)`. Stored rows and audit edit payloads retain their earlier format. Published versions are in the [release notes](https://github.com/gura105/operational-ontology/releases).

For the set API migration: replace array access on `search` / `traverse` with `.objects`, use `pivot` for sets, and replace equality shorthand with structured conditions. Aggregation now takes an ObjectSet and a property-based `groupBy`, with optional numeric `sum`, and returns `{ set, columns, values }`; link-based or custom metrics belong in model Functions. The older array-return and callback-aggregation forms are not retained as overloads.

For this branch's type simplification, `Where` and `TraverseOptions` no longer take model parameters, and `AggregationResult<O>` no longer takes metric names. Model-dependent name, parameter and link-navigation aliases are removed. Call expressions and JSON formats remain the same; mistakes previously caught by those input types reach runtime validation instead.
