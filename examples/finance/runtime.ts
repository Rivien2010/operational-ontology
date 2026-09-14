import Database from 'better-sqlite3'
import { createRuntime, type Runtime } from '../../src/core.js'
import { createFixtures } from './fixtures.js'
import { integrate } from './integrate.js'
import { createFinanceOntology, type Finance } from './ontology.js'

export function createFinance() {
  const sources = createFixtures()
  const store = new Database(':memory:')
  let rt: Runtime<Finance>
  rt = createRuntime(createFinanceOntology(() => rt), store)
  rt.load(integrate(sources))
  return { rt, sources, close: () => store.close() }
}
