import Database from 'better-sqlite3'
import { createRuntime, type Runtime } from '../../src/core.js'
import { createFixtures } from './fixtures.js'
import { integrate } from './integrate.js'
import { createHospitalOntology, type Hospital } from './ontology.js'

export function createHospital() {
  const sources = createFixtures()
  const store = new Database(':memory:')
  let rt: Runtime<Hospital>
  rt = createRuntime(createHospitalOntology(() => rt), store)
  rt.load(integrate(sources))
  return { rt, sources, close: () => store.close() }
}
