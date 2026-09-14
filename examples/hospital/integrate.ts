import type { createFixtures } from './fixtures.js'

/** Source reference fields become links; source readiness stays source-owned. */
export function integrate(sources: ReturnType<typeof createFixtures>) {
  return {
    objects: {
      Hospital: sources.hospitals.map((row) => ({ ...row })),
      Patient: sources.patients.map(({ hospital_id, ...row }) => row),
      Admission: sources.admissions.map(({ patient_id, ...row }) => row),
      Bed: sources.beds.map(({ hospital_id, ...row }) => row),
      Nurse: sources.nurses.map(({ hospital_id, ...row }) => row),
    },
    links: {
      hospitalPatients: sources.patients.map((r): [string, string] => [r.hospital_id, r.id]),
      patientAdmission: sources.admissions.map((r): [string, string] => [r.patient_id, r.id]),
      hospitalBeds: sources.beds.map((r): [string, string] => [r.hospital_id, r.id]),
      hospitalNurses: sources.nurses.map((r): [string, string] => [r.hospital_id, r.id]),
    },
  }
}
