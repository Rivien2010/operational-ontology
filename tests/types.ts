/** Type examples pair accepted and rejected calls. tsc checks the uncalled block and every @ts-expect-error. */
import { z } from 'zod'
import {
  aggregationResult, objectSet, defineAction, defineFunction, defineLink, defineObject, defineOntology, modify, reject,
  type ObjectInstance, type ObjectOf, type ObjectSet,
  type Runtime, type ActionResult, type AggregationResult,
} from '../src/index.js'

const objects = {
  Customer: defineObject({ primaryKey: 'id', properties: { id: z.string(), name: z.string() } }),
  Order: defineObject({
    primaryKey: 'id',
    properties: { id: z.string(), status: z.enum(['pending', 'shipped', 'cancelled']), total: z.number().int() },
  }),
}
const model = defineOntology({
  name: 'typed', objects,
  links: {
    customerOrders: defineLink({ from: 'Customer', to: 'Order', kind: 'one-to-many' }),
  },
  actions: {
    cancelOrder: defineAction(objects, {
      object: 'Order', targetParam: 'orderId',
      params: { orderId: z.string(), reason: z.string().min(1) },
      preconditions: [({ object }) => object.properties.status === 'shipped'
        ? reject('SHIPPED', `order ${object.pk} has shipped`) : undefined],
      effects: ({ object }) => [modify(object, { status: 'cancelled' })],
      writeback: true,
    }),
  },
})

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const assertType = <_T extends true>(): void => {}
type Customer = ObjectInstance<'Customer', { id: string; name: string }>
type Order = ObjectInstance<'Order', { id: string; status: 'pending' | 'shipped' | 'cancelled'; total: number }>
const actor = { actor: 'admin' }

assertType<Same<ObjectOf<typeof model, 'Customer'>, Customer>>()
assertType<Same<ObjectOf<typeof model, 'Order'>, Order>>()

/** Basic shapes and direct result lookups remain; inputs are not a model-driven menu. */
export function compileOnly(rt: Runtime<typeof model>, name: string): void {
  const order = rt.get('Order', 'O1', actor)!
  assertType<Same<typeof order, Order>>()
  assertType<Same<ReturnType<typeof rt.traverse>, ObjectSet>>()
  const dynamic = rt.get(name, 'id', actor)
  assertType<Same<typeof dynamic, ObjectInstance | undefined>>()
  const pending = rt.search('Order', { ...actor, filter: (o) => o.properties.total > 100 })
  assertType<Same<typeof pending, ObjectSet<Order>>>()
  // @ts-expect-error identity is readonly
  order.type = 'Order'
  // @ts-expect-error properties belong in the properties field
  order.status
  // @ts-expect-error get's explicit object name still gives concrete properties
  order.properties.missing
  // @ts-expect-error traversal still requires an instance with properties
  rt.traverse({ type: 'Order', pk: 'O1' }, 'customerOrders', actor)
  // @ts-expect-error direction has a fixed vocabulary even without model-dependent choices
  rt.traverse(order, 'customerOrders', { ...actor, direction: 'sideways' })

  // These compile; core.test.ts and query.test.ts exercise refusal.
  rt.get('Unknown', 'id', actor)
  rt.traverse(order, name, actor)
  rt.traverse(order, 'unknownLink', actor)
  // @ts-expect-error predicate callbacks retain the properties of an explicit object type
  rt.search('Order', { ...actor, filter: (object) => object.properties.status === 'lost' })
  rt.execute('cancelOrder', { orderId: 'O1' }, actor)
  rt.execute(name, {}, actor)
  modify(order, { status: 'lost', missing: 1 })

  defineAction(objects, {
    object: 'Order', targetParam: 'orderId', params: { orderId: z.string(), count: z.number() },
    preconditions: [({ object, params }) => {
      assertType<Same<typeof object, Order>>()
      assertType<Same<typeof params.count, number>>()
      // @ts-expect-error model authors retain concrete property types
      object.properties.name
      // @ts-expect-error rule parameters are parsed according to their schemas
      params.reason
    }], effects: () => [],
  })
}

const functionModel = defineOntology({
  ...model,
  functions: {
    labels: defineFunction({
      params: { prefix: z.string(), count: z.number().int().positive().default(1) },
      run: ({ params }) => Array.from({ length: params.count }, () => params.prefix),
    }),
    whoAmI: defineFunction({ params: {}, run: async ({ actor }) => actor }),
  },
})

export function compileOnlyFunctions(rt: Runtime<typeof functionModel>, name: string): void {
  const labels = rt.call('labels', { prefix: 'order' }, actor)
  assertType<Same<typeof labels, string[]>>()
  const identity = rt.call('whoAmI', {}, actor)
  assertType<Same<typeof identity, Promise<string>>>()
  const cancelled = rt.execute('cancelOrder', { orderId: 'O1', reason: 'duplicate' }, actor)
  assertType<Same<typeof cancelled, ActionResult>>()
  const dynamic = rt.call(name, {}, actor)
  assertType<Same<typeof dynamic, unknown>>()
  // Argument validation belongs to the model's Zod schemas at runtime.
  rt.call('labels', { prefix: 'order', count: 'two' }, actor)
  rt.call('unknownFunction', {}, actor)
  rt.execute('labels', {}, actor)
}

/** Fixed data shapes stay typed; schema-specific combinations are runtime checks. */
export function compileOnlySets(rt: Runtime<typeof model>) {
  const input = rt.search('Order', { actor: 'admin' })
  const customers = rt.search('Customer', { actor: 'admin' })
  // @ts-expect-error arrays are readonly
  input.objects.push(input.objects[0])
  // @ts-expect-error tags are readonly
  input.type = 'Order'
  // @ts-expect-error filter accepts only a predicate
  rt.filter(input, { status: 'pending' })
  // @ts-expect-error filter accepts callbacks, not serialized conditions
  rt.filter(input, [{ property: 'total', op: 'approximately', value: 40 }])
  const custom = aggregationResult(input, [{ key: 'X', pks: ['O1'], metrics: { senderCount: 3 } }])
  const selected: AggregationResult<Order> = rt.filter(custom, (row) => row.metrics.senderCount >= 2)
  const exact: ObjectSet<Order> = selected.set
  // @ts-expect-error metrics are numeric
  aggregationResult(input, [{ key: 'X', pks: ['O1'], metrics: { count: 'three' } }])
  // @ts-expect-error metric snapshots are readonly
  selected.values[0].metrics.senderCount = 4
  // These are accepted by TypeScript and rejected in query.test.ts.
  rt.union(input, customers)
  objectSet('Customer', input.objects)
  // @ts-expect-error predicates must be synchronous
  rt.filter(input, async () => true)
  rt.aggregate(input, { groupBy: 'status', sum: 'status' })
  void exact
}
