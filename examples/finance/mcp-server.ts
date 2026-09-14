import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildMcpServer } from '../../src/mcp.js'
import { createFinance } from './runtime.js'

const { rt } = createFinance()
await buildMcpServer(rt, { agent: process.env.OO_AGENT }).connect(new StdioServerTransport())
console.error('operational-ontology: finance ontology served over stdio')
