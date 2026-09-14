/** Synthetic source records for one fixed admission-planning window: September 8, day shift. */
export function createFixtures() {
  return {
    hospitals: [{ id: 'H', name: 'Example Hospital' }],
    patients: [
      { id: 'P1', hospital_id: 'H', status: 'waiting', requiredEquipment: 'K' },
      { id: 'P2', hospital_id: 'H', status: 'waiting', requiredEquipment: 'K' },
      { id: 'P3', hospital_id: 'H', status: 'admitted', requiredEquipment: 'K' },
      // A second fully specified, confirmed patient exposes resource competition after P1's allocation.
      { id: 'P4', hospital_id: 'H', status: 'waiting', requiredEquipment: 'K' },
    ],
    admissions: [
      { id: 'C1', patient_id: 'P1', confirmation: 'approved' },
      { id: 'C2', patient_id: 'P2', confirmation: 'pending' },
      { id: 'C4', patient_id: 'P4', confirmation: 'approved' },
    ],
    beds: [
      { id: 'B101', hospital_id: 'H', status: 'ready', equipment: ['K'], area: 'A', reserved: false },
      { id: 'B102', hospital_id: 'H', status: 'cleaning', equipment: ['K'], area: 'A', reserved: false },
      { id: 'B103', hospital_id: 'H', status: 'ready', equipment: [], area: 'A', reserved: false },
      { id: 'B104', hospital_id: 'H', status: 'ready', equipment: ['K'], area: 'A', reserved: true },
    ],
    nurses: [
      { id: 'N1', hospital_id: 'H', shift: 'day', area: 'A', slots: 1 },
      { id: 'N2', hospital_id: 'H', shift: 'day', area: 'A', slots: 0 },
      { id: 'N3', hospital_id: 'H', shift: 'night', area: 'A', slots: 1 },
    ],
  }
}
