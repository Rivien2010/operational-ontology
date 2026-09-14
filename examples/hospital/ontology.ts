import { z } from 'zod'
import {
  create, defineAction, defineFunction, defineLink, defineObject, defineOntology, link, objectSet, reject,
  type ObjectOf, type ObjectSet, type Runtime, type Violation,
} from '../../src/core.js'

const objects = {
  Hospital: defineObject({ primaryKey: 'id', source: 'hospital directory', properties: { id: z.string(), name: z.string() } }),
  Patient: defineObject({
    primaryKey: 'id', source: 'admissions',
    properties: { id: z.string(), status: z.enum(['waiting', 'admitted']), requiredEquipment: z.string() },
  }),
  Admission: defineObject({
    primaryKey: 'id', source: 'admission confirmation',
    properties: { id: z.string(), confirmation: z.enum(['approved', 'pending']) },
  }),
  Bed: defineObject({
    primaryKey: 'id', source: 'bed register',
    properties: { id: z.string(), status: z.enum(['ready', 'cleaning']), equipment: z.array(z.string()), area: z.string(), reserved: z.boolean() },
  }),
  Nurse: defineObject({
    primaryKey: 'id', source: 'current shift roster',
    properties: { id: z.string(), shift: z.enum(['day', 'night']), area: z.string(), slots: z.number().int().nonnegative() },
  }),
  Allocation: defineObject({
    primaryKey: 'id', owned: true,
    properties: { id: z.string(), note: z.string() },
    description: 'A provisional plan for the fixed September 8 day shift. No source system has accepted a physical admission.',
  }),
}

const schema = defineOntology({
  name: 'hospital', objects,
  links: {
    hospitalPatients: defineLink({ from: 'Hospital', to: 'Patient', kind: 'one-to-many', via: 'admissions.hospital_id' }),
    patientAdmission: defineLink({ from: 'Patient', to: 'Admission', kind: 'one-to-many', via: 'admission_confirmation.patient_id' }),
    hospitalBeds: defineLink({ from: 'Hospital', to: 'Bed', kind: 'one-to-many', via: 'bed_register.hospital_id' }),
    hospitalNurses: defineLink({ from: 'Hospital', to: 'Nurse', kind: 'one-to-many', via: 'roster.hospital_id' }),
    patientAllocations: defineLink({ from: 'Patient', to: 'Allocation', kind: 'one-to-many', owned: true }),
    bedAllocations: defineLink({ from: 'Bed', to: 'Allocation', kind: 'one-to-many', owned: true }),
    nurseAllocations: defineLink({ from: 'Nurse', to: 'Allocation', kind: 'one-to-many', owned: true }),
  },
  actions: {},
})
type Model = typeof schema
type Read = Pick<Runtime<Model>, 'get' | 'traverse' | 'pivot'>
type Patient = ObjectOf<Model, 'Patient'>
type Bed = ObjectOf<Model, 'Bed'>
type Nurse = ObjectOf<Model, 'Nurse'>

/** The rules live beside the model. Functions and the final Action share them. */
export function createHospitalOntology(read: () => Read) {
  const hospitalOf = (patient: Patient, actor: string) => read().traverse(patient, 'hospitalPatients', { actor })
  function patientReasons(patient: Patient, actor: string): Violation[] {
    const reasons: Violation[] = []
    if (patient.properties.status !== 'waiting') reasons.push(reject('NOT_WAITING', 'Patient is not waiting for admission'))
    const admissions = read().traverse(patient, 'patientAdmission', { actor }).objects
    if (admissions.length !== 1 || admissions[0].properties.confirmation !== 'approved') {
      reasons.push(reject('NOT_CONFIRMED', 'This admission must have one approved confirmation'))
    }
    if (read().traverse(patient, 'patientAllocations', { actor }).objects.length) reasons.push(reject('PATIENT_PLANNED', 'Patient already has a provisional allocation'))
    if (hospitalOf(patient, actor).objects.length !== 1) reasons.push(reject('HOSPITAL_MISSING', 'Patient must belong to one visible hospital'))
    return reasons
  }
  function bedReasons(patient: Patient, bed: Bed, actor: string): Violation[] {
    const reasons = patientReasons(patient, actor)
    const hospital = hospitalOf(patient, actor).objects[0]
    if (!hospital || !read().traverse(bed, 'hospitalBeds', { actor }).objects.some((h) => h.pk === hospital.pk)) {
      reasons.push(reject('WRONG_HOSPITAL', 'Bed belongs to a different hospital'))
    }
    if (bed.properties.status !== 'ready') reasons.push(reject('BED_NOT_READY', 'Bed is being cleaned'))
    if (!bed.properties.equipment.includes(patient.properties.requiredEquipment)) reasons.push(reject('MISSING_EQUIPMENT', 'Required equipment is unavailable'))
    if (bed.properties.reserved || read().traverse(bed, 'bedAllocations', { actor }).objects.length) {
      reasons.push(reject('BED_RESERVED', 'Bed is reserved at the source or by a provisional plan'))
    }
    return reasons
  }
  function nurseReasons(patient: Patient, bed: Bed, nurse: Nurse, actor: string): Violation[] {
    const reasons = bedReasons(patient, bed, actor)
    const hospital = hospitalOf(patient, actor).objects[0]
    if (!hospital || !read().traverse(nurse, 'hospitalNurses', { actor }).objects.some((h) => h.pk === hospital.pk)) {
      reasons.push(reject('WRONG_HOSPITAL', 'Nurse belongs to a different hospital'))
    }
    if (nurse.properties.shift !== 'day') reasons.push(reject('WRONG_SHIFT', 'This plan is for the day shift'))
    if (nurse.properties.area !== bed.properties.area) reasons.push(reject('WRONG_AREA', 'Nurse does not cover the selected bed area'))
    const plans = read().traverse(nurse, 'nurseAllocations', { actor }).objects.length
    if (nurse.properties.slots - plans < 1) reasons.push(reject('NO_CAPACITY', 'No additional slot remains after provisional plans'))
    return reasons
  }
  const patientInput = (id: string, actor: string) => {
    const patient = read().get('Patient', id, { actor })
    if (!patient) throw new Error('Patient is missing or hidden')
    return patient
  }
  return defineOntology({
    ...schema,
    functions: {
      bedSearch: defineFunction({
        description: 'Evaluate beds for a patient; return eligible beds and reasons for every assessed bed. Does not reserve.',
        params: { patientId: z.string() },
        run: ({ params, actor }) => {
          const patient = patientInput(params.patientId, actor)
          // The declared hospitalBeds link leads to schema-validated Bed instances.
          const beds = read().pivot(hospitalOf(patient, actor), 'hospitalBeds', { actor }) as ObjectSet<Bed>
          const assessments = beds.objects.map((object) => ({ object, reasons: bedReasons(patient, object, actor) }))
          return { set: objectSet('Bed', assessments.filter((a) => !a.reasons.length).map((a) => a.object)), assessments }
        },
      }),
      nurseSearch: defineFunction({
        description: 'Evaluate day-shift nurses for this patient and selected bed, including remaining capacity. Does not reserve.',
        params: { patientId: z.string(), bedId: z.string() },
        run: ({ params, actor }) => {
          const patient = patientInput(params.patientId, actor)
          const bed = read().get('Bed', params.bedId, { actor })
          if (!bed) throw new Error('Bed is missing or hidden')
          const nurses = read().pivot(hospitalOf(patient, actor), 'hospitalNurses', { actor }) as ObjectSet<Nurse>
          const assessments = nurses.objects.map((object) => ({ object, reasons: nurseReasons(patient, bed, object, actor) }))
          return { set: objectSet('Nurse', assessments.filter((a) => !a.reasons.length).map((a) => a.object)), assessments }
        },
      }),
    },
    actions: {
      allocate: defineAction(objects, {
        description: 'Recheck the whole selection and record a provisional allocation for the September 8 day shift.',
        object: 'Patient', targetParam: 'patientId',
        params: { patientId: z.string(), bedId: z.string(), nurseId: z.string(), allocationId: z.string().min(1), note: z.string().min(1) },
        preconditions: [({ object, params, actor }) => {
          const bed = read().get('Bed', params.bedId, { actor })
          const nurse = read().get('Nurse', params.nurseId, { actor })
          if (!bed || !nurse) return reject('RESOURCE_MISSING', 'Selected bed or nurse is missing or hidden')
          return nurseReasons(object, bed, nurse, actor)[0]
        }],
        effects: ({ object, params }) => [
          create('Allocation', params.allocationId, { id: params.allocationId, note: params.note }),
          link('patientAllocations', object.pk, params.allocationId),
          link('bedAllocations', params.bedId, params.allocationId),
          link('nurseAllocations', params.nurseId, params.allocationId),
        ],
      }),
    },
  })
}
export type Hospital = ReturnType<typeof createHospitalOntology>
