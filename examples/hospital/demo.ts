/** Run: pnpm demo:hospital. Every run starts with isolated synthetic records. */
import { integrate } from './integrate.js'
import { createHospital } from './runtime.js'
import { heading as h, log } from '../demo-output.js'

const app = createHospital()
const { rt } = app
const actor = 'user:admission-planner'
try {
  h('1. Read: find waiting patients with confirmed admissions')
  const patients = rt.pivot(rt.search('Hospital', { actor }), 'hospitalPatients', { actor })
  const waiting = rt.filter(patients, (object) => object.properties.status === 'waiting')
  const admissions = rt.pivot(waiting, 'patientAdmission', { actor })
  const confirmed = rt.filter(admissions, (object) => object.properties.confirmation === 'approved')
  const ready = rt.pivot(confirmed, 'patientAdmission', { actor })
  log('Waiting:', waiting.objects.map((p) => p.pk), 'Confirmed:', ready.objects.map((p) => p.pk))
  log('Returning to Patient yields P1 and P4, not every patient. Select P1 for this plan.')
  const patient = ready.objects[0]

  h('2. Read: find eligible beds and explain exclusions')
  const beds = rt.call('bedSearch', { patientId: patient.pk }, { actor })
  console.table(beds.assessments.map(({ object, reasons }) => ({ bed: object.pk, reasons: reasons.map((r) => r.message).join('; ') || 'eligible' })))
  const bed = beds.set.objects[0]

  h('3. Read: find nurses for the selected patient and bed')
  const nurses = rt.call('nurseSearch', { patientId: patient.pk, bedId: bed.pk }, { actor })
  console.table(nurses.assessments.map(({ object, reasons }) => ({ nurse: object.pk, reasons: reasons.map((r) => r.message).join('; ') || 'eligible' })))
  const nurse = nurses.set.objects[0]

  h('4. Write: record a provisional allocation')
  const plan = { patientId: patient.pk, bedId: bed.pk, nurseId: nurse.pk, allocationId: 'PLAN-1', note: 'Provisional day-shift admission plan' }
  log('Plans before execution:', rt.search('Allocation', { actor }).objects.length)
  log('Commit:', rt.execute('allocate', plan, { actor }))

  h('5. Read: the allocation changes available candidates')
  log('P1 candidates after allocation:', rt.call('bedSearch', { patientId: 'P1' }, { actor }).set.objects.length)
  log('P4 candidates after P1 consumes the bed:', rt.call('bedSearch', { patientId: 'P4' }, { actor }).set.objects.length)
  log('Source bed and nurse records are still:', app.sources.beds[0], app.sources.nurses[0])

  h('6. Re-index: the allocation and its links survive')
  rt.load(integrate(app.sources))
  const saved = rt.get('Allocation', 'PLAN-1', { actor })!
  log('Saved plan after source refresh:', saved, rt.traverse(saved, 'bedAllocations', { actor }))

  h('7. Audit log (applied AND rejected attempts)')
  for (const e of rt.auditLog()) {
    log(`  #${e.seq} ${e.status.padEnd(8)} ${e.action}(${e.target}) by ${e.actor}${e.error ? ` — ${e.error.code}` : ''}`)
  }
} finally {
  app.close()
}
