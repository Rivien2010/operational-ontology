/** Run: pnpm demo:hospital. Every run starts with isolated synthetic records. */
import { createHospital } from './runtime.js'
import { heading as h, log, trace } from '../demo-output.js'

const app = createHospital()
const { rt } = app
const actor = 'user:admission-planner'
try {
  h('1. Read: find waiting patients with confirmed admissions')
  log('Goal: choose an eligible bed and nurse, then record a provisional allocation for the September 8 day shift.')
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
  const approvedPatients = rt.pivot(confirmed, 'patientAdmission', { actor })
  trace('Pivot patientAdmission (reverse): Admission → Patient', { confirmed }, approvedPatients)
  const ready = rt.intersect(waiting, approvedPatients)
  trace('Intersect: waiting patients ∩ patients with approved confirmations', { waiting, approvedPatients }, ready)
  log('Returning to Patient yields P1 and P4, not every patient. Select P1 for this plan.')
  const selected = rt.filter(ready, (object) => object.pk === 'P1')
  trace('Select P1: the planner chooses one confirmed waiting patient', { ready }, selected)
  const patient = selected.objects[0]

  h('2. Read: find eligible beds and explain exclusions')
  log('Function bedSearch params:', { patientId: patient.pk })
  log('Selected patient requirement:', patient.properties.requiredEquipment)
  const hospital = rt.traverse(patient, 'hospitalPatients', { actor })
  trace('Inspect the Function input path: Patient → Hospital (hospitalPatients, reverse)', { patient }, hospital)
  const allBeds = rt.pivot(hospital, 'hospitalBeds', { actor })
  trace('Pivot hospitalBeds (forward): Hospital → Bed', { hospital }, allBeds)
  console.table(allBeds.objects.map(({ pk, properties: p }) => ({ bed: pk, status: p.status, equipment: (p.equipment as string[]).join(', '), area: p.area, reserved: p.reserved })))
  const beds = rt.call('bedSearch', { patientId: patient.pk }, { actor })
  // Replay the Function's evaluated reasons in the video's order. The model
  // remains responsible for the eligibility rules and the final candidate set.
  let remainingBeds = allBeds
  for (const [condition, code] of [
    ['status = ready', 'BED_NOT_READY'],
    ['equipment includes the patient requirement', 'MISSING_EQUIPMENT'],
    ['no source reservation or saved allocation', 'BED_RESERVED'],
  ]) {
    const kept = rt.filter(remainingBeds, (object) => !beds.assessments.find((a) => a.object.pk === object.pk)!.reasons.some((r) => r.code === code))
    trace(`Explain bedSearch: ${condition}`, { before: remainingBeds }, kept)
    remainingBeds = kept
  }
  trace('Function bedSearch: evaluate beds for the selected patient', { patient }, beds.set)
  log('The following assessments explain the computed candidates; these are not existing allocation links.')
  console.table(beds.assessments.map(({ object, reasons }) => ({ bed: object.pk, reasons: reasons.map((r) => r.message).join('; ') || 'eligible' })))
  const bed = beds.set.objects[0]
  log('Select bed:', bed.pk)

  h('3. Read: find nurses for the selected patient and bed')
  log('Function nurseSearch params:', { patientId: patient.pk, bedId: bed.pk })
  log('Selected bed area:', bed.properties.area)
  const nurseHospital = rt.traverse(patient, 'hospitalPatients', { actor })
  trace('Inspect the Function input path: Patient → Hospital (hospitalPatients, reverse)', { patient }, nurseHospital)
  const allNurses = rt.pivot(nurseHospital, 'hospitalNurses', { actor })
  trace('Pivot hospitalNurses (forward): Hospital → Nurse', { hospital: nurseHospital }, allNurses)
  console.table(allNurses.objects.map(({ pk, properties: p }) => ({ nurse: pk, shift: p.shift, area: p.area, slots: p.slots })))
  const nurses = rt.call('nurseSearch', { patientId: patient.pk, bedId: bed.pk }, { actor })
  let remainingNurses = allNurses
  for (const [condition, codes] of [
    ['day shift and the selected bed area', ['WRONG_SHIFT', 'WRONG_AREA']],
    ['source slots minus saved plans >= 1', ['NO_CAPACITY']],
  ] as [string, string[]][]) {
    const kept = rt.filter(remainingNurses, (object) => !nurses.assessments.find((a) => a.object.pk === object.pk)!.reasons.some((r) => codes.includes(r.code)))
    trace(`Explain nurseSearch: ${condition}`, { before: remainingNurses }, kept)
    remainingNurses = kept
  }
  trace('Function nurseSearch: evaluate the patient/bed combination', { patient, bed }, nurses.set)
  console.table(nurses.assessments.map(({ object, reasons }) => ({ nurse: object.pk, reasons: reasons.map((r) => r.message).join('; ') || 'eligible' })))
  const nurse = nurses.set.objects[0]
  log('Select nurse:', nurse.pk)

  h('4. Read: two possible proposals are still unreserved')
  const plan = { patientId: patient.pk, bedId: bed.pk, nurseId: nurse.pk, allocationId: 'PLAN-1', note: 'Provisional day-shift admission plan' }
  log('Selected plan:', plan)
  const otherPatient = ready.objects.find((object) => object.pk === 'P4')!
  const otherBeds = rt.call('bedSearch', { patientId: otherPatient.pk }, { actor })
  trace('Function bedSearch(P4): the same bed is still a candidate', { patient: otherPatient }, otherBeds.set)
  const otherBed = otherBeds.set.objects[0]
  const otherNurses = rt.call('nurseSearch', { patientId: otherPatient.pk, bedId: otherBed.pk }, { actor })
  trace('Function nurseSearch(P4, B101): the same nurse is still a candidate', { patient: otherPatient, bed: otherBed }, otherNurses.set)
  const otherPlan = { ...plan, patientId: otherPatient.pk, bedId: otherBed.pk, nurseId: otherNurses.set.objects[0].pk, allocationId: 'PLAN-2' }
  log('Keep this alternative proposal for later:', otherPlan)
  log('Plans before execution:', rt.search('Allocation', { actor }).objects.length)
  log('Candidate checks and selection save nothing. They do not reserve the bed or nurse for either patient.')

  h('5. Write: record one provisional allocation and its three links')
  log('Execution rechecks the whole patient/bed/nurse combination against current records.')
  log('Commit:', rt.execute('allocate', plan, { actor }))
  const saved = rt.get('Allocation', 'PLAN-1', { actor })!
  log('Saved allocation:', saved)
  for (const link of ['patientAllocations', 'bedAllocations', 'nurseAllocations']) {
    trace(`Traverse ${link} (reverse): allocation → planned resource`, { allocation: saved }, rt.traverse(saved, link, { actor }))
  }

  h('6. Read: source facts plus saved plans determine availability')
  log('Source bed and nurse records are still:', app.sources.beds[0], app.sources.nurses[0])
  const nursePlans = rt.traverse(nurse, 'nurseAllocations', { actor })
  trace('Traverse nurseAllocations (forward): Nurse → saved plans', { nurse }, nursePlans)
  log('Effective nurse capacity:', { sourceSlots: nurse.properties.slots, savedPlans: nursePlans.objects.length, remaining: (nurse.properties.slots as number) - nursePlans.objects.length })
  for (const patientId of [patient.pk, 'P4']) {
    const currentPatient = rt.get('Patient', patientId, { actor })!
    const remaining = rt.call('bedSearch', { patientId }, { actor })
    trace(`Function bedSearch(${patientId}) after allocation`, { patient: currentPatient }, remaining.set)
    for (const { object, reasons } of remaining.assessments) {
      log(`    ${object.pk}: ${reasons.length ? 'excluded' : 'eligible'}`)
      for (const reason of reasons) log(`      ${reason.code}: ${reason.message}`)
    }
  }
  log('P1 already has a plan. P4 is still confirmed and waiting, but B101 and N1 have been consumed by that plan.')

  h('7. Write: reject the previously eligible alternative')
  log('Execute the earlier P4 proposal:', rt.execute('allocate', otherPlan, { actor }))
  log('Plans after the rejected attempt:', rt.search('Allocation', { actor }).objects.length)
  log('Next task: arrange the actual admission in the source system. This demo ends with one provisional plan.')

  h('8. Audit log (applied AND rejected attempts)')
  for (const e of rt.auditLog()) {
    log(`  #${e.seq} ${e.status.padEnd(8)} ${e.action}(${e.target}) by ${e.actor}${e.error ? ` — ${e.error.code}` : ''}`)
  }
} finally {
  app.close()
}
