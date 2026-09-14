import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildMcpServer } from '../../src/mcp.js'
import { createHospital } from './runtime.js'

const { rt } = createHospital()
await buildMcpServer(rt, { agent: process.env.OO_AGENT }).connect(new StdioServerTransport())
console.error('operational-ontology: hospital ontology served over stdio')
