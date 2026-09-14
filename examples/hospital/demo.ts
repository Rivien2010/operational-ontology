/** Run: pnpm demo:hospital. Every run starts with isolated synthetic records. */
import { integrate } from './integrate.js'
import { createHospital } from './runtime.js'
import { heading as h, log, trace } from '../demo-output.js'

const app = createHospital()
const { rt } = app
const actor = 'user:admission-planner'
try {
  h('1. Read: find waiting patients with confirmed admissions')
  const hospitals = rt.search('Hospital', { actor })
  trace('Search Hospital: start with the admission-planning hospital', {}, hospitals)
  const patients = rt.pivot(hospitals, 'hospitalPatients', { actor })
  trace('Pivot hospitalPatients (forward): Hospital → Patient', { hospitals }, patients)
  console.table(patients.objects.map(({ pk, properties }) => ({ patient: pk, status: properties.status })))
  const waiting = rt.filter(patients, (object) => object.properties.status === 'waiting')
  trace('Filter status = waiting: exclude patients already admitted', { patients }, waiting)
  const admissions = rt.pivot(waiting, 'patientAdmission', { actor })
  trace('Pivot patientAdmission (forward): Patient → Admission', { waiting }, admissions)
  console.table(admissions.objects.map(({ pk, properties }) => ({ admission: pk, confirmation: properties.confirmation })))
  const confirmed = rt.filter(admissions, (object) => object.properties.confirmation === 'approved')
  trace('Filter confirmation = approved: keep completed reception checks', { admissions }, confirmed)
  const ready = rt.pivot(confirmed, 'patientAdmission', { actor })
  trace('Pivot patientAdmission (reverse): Admission → Patient', { confirmed }, ready)
  log('Returning to Patient yields P1 and P4, not every patient. Select P1 for this plan.')
  const patient = ready.objects[0]

  h('2. Read: find eligible beds and explain exclusions')
  const beds = rt.call('bedSearch', { patientId: patient.pk }, { actor })
  trace('Function bedSearch: evaluate beds for the selected patient', { patient }, beds.set)
  log('The following assessments explain the computed candidates; these are not existing allocation links.')
  console.table(beds.assessments.map(({ object, reasons }) => ({ bed: object.pk, reasons: reasons.map((r) => r.message).join('; ') || 'eligible' })))
  const bed = beds.set.objects[0]
  log('Select bed:', bed.pk)

  h('3. Read: find nurses for the selected patient and bed')
  const nurses = rt.call('nurseSearch', { patientId: patient.pk, bedId: bed.pk }, { actor })
  trace('Function nurseSearch: evaluate the patient/bed combination', { patient, bed }, nurses.set)
  console.table(nurses.assessments.map(({ object, reasons }) => ({ nurse: object.pk, reasons: reasons.map((r) => r.message).join('; ') || 'eligible' })))
  const nurse = nurses.set.objects[0]
  log('Select nurse:', nurse.pk)

  h('4. Write: record a provisional allocation')
  const plan = { patientId: patient.pk, bedId: bed.pk, nurseId: nurse.pk, allocationId: 'PLAN-1', note: 'Provisional day-shift admission plan' }
  log('Selected plan:', plan)
  log('Plans before execution:', rt.search('Allocation', { actor }).objects.length)
  log('Commit:', rt.execute('allocate', plan, { actor }))

  h('5. Read: the allocation changes available candidates')
  for (const patientId of [patient.pk, 'P4']) {
    const currentPatient = rt.get('Patient', patientId, { actor })!
    const remaining = rt.call('bedSearch', { patientId }, { actor })
    trace(`Function bedSearch(${patientId}) after allocation`, { patient: currentPatient }, remaining.set)
    for (const { object, reasons } of remaining.assessments) {
      log(`    ${object.pk}: ${reasons.length ? 'excluded' : 'eligible'}`)
      for (const reason of reasons) log(`      ${reason.code}: ${reason.message}`)
    }
  }
  log('Source bed and nurse records are still:', app.sources.beds[0], app.sources.nurses[0])

  h('6. Re-index: the allocation and its links survive')
  rt.load(integrate(app.sources))
  const saved = rt.get('Allocation', 'PLAN-1', { actor })!
  const savedBeds = rt.traverse(saved, 'bedAllocations', { actor })
  trace('Traverse bedAllocations (reverse): Allocation → Bed', { allocation: saved }, savedBeds)
  log('Saved plan after source refresh:', saved, savedBeds)

  h('7. Audit log (applied AND rejected attempts)')
  for (const e of rt.auditLog()) {
    log(`  #${e.seq} ${e.status.padEnd(8)} ${e.action}(${e.target}) by ${e.actor}${e.error ? ` — ${e.error.code}` : ''}`)
  }
} finally {
  app.close()
}
