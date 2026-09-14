/** Run: pnpm demo:hospital. Every run starts with isolated synthetic records. */
import { integrate } from './integrate.js'
import { createHospital } from './runtime.js'

const app = createHospital()
const { rt } = app
const actor = 'user:admission-planner'
try {
  const patients = rt.pivot(rt.search('Hospital', { actor }), 'hospitalPatients', { actor })
  const waiting = rt.filter(patients, [{ property: 'status', op: 'eq', value: 'waiting' }])
  const admissions = rt.pivot(waiting, 'patientAdmission', { actor })
  const confirmed = rt.filter(admissions, [{ property: 'confirmation', op: 'eq', value: 'approved' }])
  const ready = rt.pivot(confirmed, 'patientAdmission', { actor })
  console.log('Waiting:', waiting.objects.map((p) => p.pk), 'Confirmed:', ready.objects.map((p) => p.pk))
  console.log('Returning to Patient yields P1 and P4, not every patient. Select P1 for this plan.')
  const patient = ready.objects[0]
  const beds = rt.run('bedSearch', { patientId: patient.pk }, { actor })
  console.table(beds.assessments.map(({ object, reasons }) => ({ bed: object.pk, reasons: reasons.map((r) => r.message).join('; ') || 'eligible' })))
  const bed = beds.set.objects[0]
  const nurses = rt.run('nurseSearch', { patientId: patient.pk, bedId: bed.pk }, { actor })
  console.table(nurses.assessments.map(({ object, reasons }) => ({ nurse: object.pk, reasons: reasons.map((r) => r.message).join('; ') || 'eligible' })))
  const nurse = nurses.set.objects[0]
  const plan = { patientId: patient.pk, bedId: bed.pk, nurseId: nurse.pk, allocationId: 'PLAN-1', note: 'Provisional day-shift admission plan' }
  console.log('Preview:', rt.preview('allocate', plan, { actor }))
  console.log('Plans before execution:', rt.search('Allocation', { actor }).objects.length)
  console.log('Commit:', rt.run('allocate', plan, { actor }))
  console.log('P1 candidates after allocation:', rt.run('bedSearch', { patientId: 'P1' }, { actor }).set.objects.length)
  console.log('P4 candidates after P1 consumes the bed:', rt.run('bedSearch', { patientId: 'P4' }, { actor }).set.objects.length)
  console.log('Source bed and nurse records are still:', app.sources.beds[0], app.sources.nurses[0])
  rt.load(integrate(app.sources))
  const saved = rt.get('Allocation', 'PLAN-1', { actor })!
  console.log('Saved plan after source refresh:', saved, rt.traverse(saved, 'bedAllocations', { actor }))
  console.log('Audit:', rt.auditLog())
} finally {
  app.close()
}
