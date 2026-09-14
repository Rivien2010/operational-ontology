/** Type examples pair accepted and rejected calls. tsc checks the uncalled block and every @ts-expect-error. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { z } from 'zod'
import {
  createRuntime, defineAction, defineFunction, defineLink, defineObject, defineOntology, modify, reject,
  type ObjectInstance, type ObjectOf, type ObjectSet,
  type Runtime, type ActionResult,
} from '../src/index.js'

const objects = {
  Customer: defineObject({ primaryKey: 'id', properties: { id: z.string(), name: z.string() } }),
  Order: defineObject({
    primaryKey: 'id',
    properties: { id: z.string(), status: z.enum(['pending', 'shipped', 'cancelled']), total: z.number().int() },
  }),
  Employee: defineObject({
    primaryKey: 'employeeId',
    properties: { employeeId: z.string(), name: z.string(), owner: z.string() },
    visibility: ({ object, actor }) => actor === 'admin' || object.properties.owner === actor,
  }),
}
const model = defineOntology({
  name: 'typed', objects,
  links: {
    customerOrders: defineLink({ from: 'Customer', to: 'Order', kind: 'one-to-many' }),
    manages: defineLink({ from: 'Employee', to: 'Employee', kind: 'one-to-many' }),
  },
  actions: {
    cancelOrder: defineAction(objects, {
      object: 'Order', targetParam: 'orderId',
      params: { orderId: z.string(), reason: z.string().min(1) },
      preconditions: [({ object }) => object.properties.status === 'shipped'
        ? reject('SHIPPED', `order ${object.pk} has shipped`) : undefined],
      effects: ({ object, params }) => {
        assert.equal(object.type, 'Order')
        assert.equal(typeof params.reason, 'string')
        return [modify(object, { status: 'cancelled' })]
      },
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

  // These compile; runtime tests below and in core/query.test.ts exercise refusal.
  rt.get('Unknown', 'id', actor)
  rt.traverse(order, name, actor)
  rt.traverse(order, 'manages', actor)
  rt.search('Order', { ...actor, filter: [{ property: 'status', op: 'eq', value: 'lost' }] })
  rt.run('cancelOrder', { orderId: 'O1' }, actor)
  rt.preview(name, {}, actor)
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
  const labels = rt.run('labels', { prefix: 'order' }, actor)
  assertType<Same<typeof labels, string[]>>()
  const identity = rt.run('whoAmI', {}, actor)
  assertType<Same<typeof identity, Promise<string>>>()
  const cancelled = rt.run('cancelOrder', { orderId: 'O1', reason: 'duplicate' }, actor)
  assertType<Same<typeof cancelled, ActionResult>>()
  const dynamic = rt.run(name, {}, actor)
  assertType<Same<typeof dynamic, unknown>>()
  // Argument validation belongs to the model's Zod schemas at runtime.
  rt.run('labels', { prefix: 'order', count: 'two' }, actor)
  rt.run('unknownFunction', {}, actor)
  rt.preview('labels', {}, actor)
}

function setup() {
  const rt = createRuntime(model, new Database(':memory:'), { writeback: { apply: () => {} } })
  rt.load({
    objects: {
      Customer: [{ id: 'C1', name: 'Yamada' }],
      Order: [{ id: 'O1', status: 'pending', total: 100 }, { id: 'O2', status: 'shipped', total: 200 }],
      Employee: [
        { employeeId: 'E1', name: 'Aki', owner: 'alice' },
        { employeeId: 'E2', name: 'Ren', owner: 'alice' },
        { employeeId: 'E3', name: 'Mio', owner: 'bob' },
      ],
    },
    links: { customerOrders: [['C1', 'O1'], ['C1', 'O2']], manages: [['E1', 'E2'], ['E2', 'E3']] },
  })
  return rt
}

test('reads, traversal, callbacks and action targets share the instance shape', () => {
  const rt = setup()
  const customer = rt.get('Customer', 'C1', actor)!
  assert.deepEqual(customer, { type: 'Customer', pk: 'C1', properties: { id: 'C1', name: 'Yamada' } })
  const orders = rt.traverse(customer, 'customerOrders', actor).objects
  assert.deepEqual(orders.map((o) => o.pk), ['O1', 'O2'])
  assert.deepEqual(rt.traverse(orders[0], 'customerOrders', actor).objects, [customer])
  assert.deepEqual(rt.search('Order', { ...actor, filter: (o) => o.properties.status === 'pending' }).objects, [orders[0]])
  const pending = rt.search('Order', { ...actor, filter: [{ property: 'status', op: 'eq', value: 'pending' }] })
  assert.deepEqual(rt.aggregate(pending, { groupBy: 'status', sum: 'total' }).values,
    [{ key: 'pending', pks: ['O1'], count: 1, sum: 100 }])
  assert.equal(rt.run('cancelOrder', { orderId: 'O1', reason: 'duplicate' }, actor).ok, true)
  assert.equal(rt.get('Order', 'O1', actor)!.properties.status, 'cancelled')
  assert.equal(orders[0].properties.status, 'pending', 'an earlier read is a snapshot')
  assert.equal(rt.run('cancelOrder', { orderId: 'O2', reason: 'duplicate' }, actor).ok, false)
})

test('same-type links require direction even at an endpoint with only incoming or outgoing edges', () => {
  const rt = setup()
  const ren = rt.get('Employee', 'E2', actor)!
  assert.deepEqual(rt.traverse(ren, 'manages', { ...actor, direction: 'reverse' }).objects.map((o) => o.properties.name), ['Aki'])
  assert.deepEqual(rt.traverse(ren, 'manages', { ...actor, direction: 'forward' }).objects.map((o) => o.properties.name), ['Mio'])
  for (const employee of rt.search('Employee', actor).objects) {
    assert.throws(() => rt.traverse(employee, 'manages', actor).objects, /requires a direction/)
  }
})

test('traversal validates source and direction and re-reads visibility from stored properties', () => {
  const rt = setup()
  const customer = rt.get('Customer', 'C1', actor)!
  assert.throws(() => rt.traverse(customer, 'customerOrders', { ...actor, direction: 'reverse' }).objects, /invalid direction/)
  assert.throws(() => rt.traverse(customer, 'manages', { ...actor, direction: 'forward' }).objects, /does not connect/)
  // @ts-expect-error runtime defense against the old reference API
  assert.throws(() => rt.traverse({ type: 'Customer', pk: 'C1' }, 'customerOrders', actor).objects, /requires an object instance/)
  const ren = rt.get('Employee', 'E2', actor)!
  // @ts-expect-error runtime defense against a non-direction value
  assert.throws(() => rt.traverse(ren, 'manages', { ...actor, direction: null }).objects, /invalid direction/)
  ren.properties.owner = 'bob'
  // A caller cannot supply visibility-granting properties. The stored owner is alice.
  assert.deepEqual(rt.traverse(ren, 'manages', { actor: 'bob', direction: 'forward' }).objects, [])
  assert.deepEqual(rt.traverse(ren, 'manages', { actor: 'alice', direction: 'forward' }).objects, [], 'hidden destination')
  assert.deepEqual(rt.traverse(ren, 'manages', { actor: 'alice', direction: 'reverse' }).objects.map((o) => o.pk), ['E1'])
  assert.deepEqual(rt.traverse({ ...customer, pk: 'missing' }, 'customerOrders', actor).objects, [])
})

test('identity does not collide with business properties or primary keys in another type', () => {
  const model = defineOntology({
    name: 'identity',
    objects: {
      Left: defineObject({
        primaryKey: 'code',
        properties: { code: z.string(), type: z.string(), pk: z.string(), properties: z.string() },
      }),
      Right: defineObject({ primaryKey: 'key', properties: { key: z.string() } }),
    },
    links: { pair: defineLink({ from: 'Left', to: 'Right', kind: 'one-to-many' }) },
    actions: {},
  })
  const rt = createRuntime(model, new Database(':memory:'))
  const properties = { code: 'same', type: 'business type', pk: 'business pk', properties: 'business value' }
  rt.load({ objects: { Left: [properties], Right: [{ key: 'same' }] }, links: { pair: [['same', 'same']] } })
  const left = rt.get('Left', 'same', actor)!
  const right = rt.get('Right', 'same', actor)!
  assert.deepEqual(left, { type: 'Left', pk: 'same', properties })
  assert.deepEqual(rt.traverse(left, 'pair', actor).objects, [right])
  assert.deepEqual(rt.traverse(right, 'pair', actor).objects, [left])
  assert.deepEqual(rt.search('Left', { ...actor, filter: [{ property: 'type', op: 'eq', value: 'business type' }] }).objects, [left])
  assert.deepEqual(modify(left, { type: 'new business type' }), {
    op: 'modify', object: 'Left', pk: 'same', changes: { type: 'new business type' },
  })
})
