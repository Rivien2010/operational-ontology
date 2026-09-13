import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createRuntime, defineAction, defineObject, defineFunction, defineOntology } from '../src/index.js'
import { buildMcpServer } from '../src/mcp.js'

test('model functions validate inputs before running, pass the actor, and do not audit reads', (t) => {
  const db = new Database(':memory:')
  t.after(() => db.close())
  const observed: string[] = []
  const rt = createRuntime(defineOntology({
    name: 'functions', objects: {}, links: {}, actions: {},
    functions: {
      label: defineFunction({
        params: { prefix: z.string().min(1), count: z.number().int().positive().default(1) },
        run: ({ params, actor }) => {
          observed.push(actor)
          return { label: params.prefix.repeat(params.count), actor }
        },
      }),
      broken: defineFunction({ params: {}, run: () => { throw new Error('function crashed') } }),
    },
  }), db)
  assert.deepEqual(rt.run('label', { prefix: 'x' }, { actor: 'user:alice' }), { label: 'x', actor: 'user:alice' })
  assert.throws(() => rt.run('label', { prefix: '', count: 2 }, { actor: 'user:bob' }), z.ZodError)
  assert.deepEqual(observed, ['user:alice'], 'invalid params must not reach model code')
  assert.throws(() => rt.run('broken', {}, { actor: 'user:alice' }), /function crashed/)
  // @ts-expect-error exercise dynamic callers and the prototype-name boundary
  assert.throws(() => rt.run('toString', {}, { actor: 'user:alice' }), /unknown operation/)
  assert.deepEqual(rt.auditLog(), [])
})

test('action and function names must be unambiguous, including models passed directly to the runtime', (t) => {
  const db = new Database(':memory:')
  t.after(() => db.close())
  const objects = { Item: defineObject({ primaryKey: 'id', properties: { id: z.string() } }) }
  const model = {
    name: 'collision', objects, links: {},
    actions: { inspect: defineAction(objects, {
      object: 'Item', targetParam: 'id', params: { id: z.string() }, preconditions: [], effects: () => [],
    }) },
    functions: { inspect: defineFunction({ params: {}, run: () => [] }) },
  }
  assert.throws(() => defineOntology(model), /operation "inspect" is defined as both/)
  assert.throws(() => createRuntime(model, db), /operation "inspect" is defined as both/)
})

test('MCP functions receive the session actor, surface exceptions, and share the tool-name collision check', async (t) => {
  const db = new Database(':memory:')
  const model = defineOntology({
    name: 'function-errors', objects: {}, links: {}, actions: {},
    functions: {
      whoAmI: defineFunction({
        params: { prefix: z.string().min(1) },
        run: async ({ params, actor }) => `${params.prefix}${actor}`,
      }),
      broken: defineFunction({ params: {}, run: () => { throw new Error('function crashed') } }),
    },
  })
  const rt = createRuntime(model, db)
  const server = buildMcpServer(rt, { agent: 'reader' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'function-test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  t.after(async () => { await client.close(); await server.close(); db.close() })
  const tool = (await client.listTools()).tools.find((tool) => tool.name === 'who_am_i')!
  assert.equal(tool.annotations?.readOnlyHint, true)
  assert.deepEqual(tool.inputSchema.required, ['prefix'])
  const identity = await client.callTool({ name: 'who_am_i', arguments: { prefix: 'hello ' } })
  assert.deepEqual(identity.content, [{ type: 'text', text: '"hello agent:reader"' }])
  const invalid = await client.callTool({ name: 'who_am_i', arguments: { prefix: '' } })
  assert.equal(invalid.isError, true)
  const crashed = await client.callTool({ name: 'broken', arguments: {} })
  assert.equal(crashed.isError, true)
  assert.match(JSON.stringify(crashed.content), /INTERNAL/)
  assert.deepEqual(rt.auditLog(), [])

  const otherDb = new Database(':memory:')
  t.after(() => otherDb.close())
  const collision = createRuntime({
    ...model, functions: { readAuditLog: defineFunction({ params: {}, run: () => [] }) },
  }, otherDb)
  assert.throws(() => buildMcpServer(collision), /tool name collision.*function readAuditLog.*built-in audit view/)
})
