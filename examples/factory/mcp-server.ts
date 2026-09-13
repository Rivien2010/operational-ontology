/** Run from the repository root: pnpm mcp:factory. Each start resets the synthetic data. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildMcpServer } from '../../src/mcp.js'
import { createFactory } from './runtime.js'

const { rt } = createFactory()
await buildMcpServer(rt, { agent: process.env.OO_AGENT }).connect(new StdioServerTransport())
console.error('operational-ontology: factory ontology served over stdio')
