import Database from 'better-sqlite3'
import { createRuntime, type Runtime } from '../../src/core.js'
import { createFixtures } from './fixtures.js'
import { integrate } from './integrate.js'
import { createFactoryOntology, type Factory } from './ontology.js'

export function createFactory() {
  const sources = createFixtures()
  const store = new Database(':memory:')
  // Rules run only on preview/run, after rt has been assigned. Keeping
  // this wiring here lets the runtime's ActionCtx stay unchanged.
  let rt: Runtime<Factory>
  const ontology = createFactoryOntology(() => rt)
  rt = createRuntime(ontology, store)
  rt.load(integrate(sources))
  return {
    rt, sources,
    close() { store.close(); sources.mes.close(); sources.wms.close() },
  }
}
