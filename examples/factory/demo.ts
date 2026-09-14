/** Run: pnpm demo:factory. Source databases and the store are reset in memory. */
import { createFactory } from './runtime.js'
import { heading as h, log, showObjects, trace } from '../demo-output.js'

const app = createFactory()
const { rt } = app
const actor = 'user:factory-ops'
const window = { after: '2026-09-06T00:00:00+09:00', before: '2026-09-07T00:00:00+09:00' }
try {
  h('1. Read: an inspection finding sets the investigation scope')
  log('Goal: find whom to contact, identify the shipped products and quantities, then record a contact task.')
  log('September 8: an equipment inspection found an anomaly. Release inspections had passed; goods shipped September 7.')
  log('September 6 is the supplied investigation window, not an inferred failure interval.')
  const allEquipment = rt.search('Equipment', { actor })
  trace('Search Equipment: inspect the recorded findings', {}, allEquipment)
  console.table(allEquipment.objects.map(({ pk, properties }) => ({ equipment: pk, inspection: properties.inspection })))
  const equipment = rt.filter(allEquipment, (object) => object.properties.inspection === 'anomaly')
  trace('Filter inspection = anomaly: choose the investigation origin', { allEquipment }, equipment)

  h('2. Read: trace affected lots to shipped lines and customers')
  const produced = rt.pivot(equipment, 'producedOn', { actor })
  trace('Pivot producedOn (forward): Equipment → Lot', { equipment }, produced)
  console.table(produced.objects.map(({ pk, properties }) => ({ lot: pk, manufacturedAt: properties.manufacturedAt })))
  const lots = rt.filter(produced, (object) => {
    const time = Date.parse(object.properties.manufacturedAt as string)
    return time >= Date.parse(window.after) && time < Date.parse(window.before)
  })
  trace(`Filter manufacturing time: ${window.after} <= time < ${window.before}`, { produced }, lots)
  log('L2 falls outside the supplied manufacturing window.')
  const lines = rt.pivot(lots, 'lotLines', { actor })
  trace('Pivot lotLines (forward): Lot → ShipmentLine', { lots }, lines)
  showObjects('Save set A: lines from the selected lots, including unshipped goods', lines)
  const allShipments = rt.pivot(lines, 'shipmentLines', { actor })
  trace('Pivot shipmentLines (reverse): ShipmentLine → Shipment', { lines }, allShipments)
  console.table(allShipments.objects.map(({ pk, properties }) => ({ shipment: pk, status: properties.status })))
  const shipments = rt.filter(allShipments, (object) => object.properties.status === 'shipped')
  trace('Filter status = shipped: keep goods already sent', { allShipments }, shipments)
  const customers = rt.pivot(shipments, 'customerShipments', { actor })
  trace('Pivot customerShipments (reverse): Shipment → Customer', { shipments }, customers)
  log('S1 and S2 converge on C1. C2 is excluded because its L2 was made September 5.')
  log('C3 has only an unshipped part of L1, so it is not in this customer set.')

  h('3. Transform: retain shipped evidence and aggregate impact')
  const packedLines = rt.pivot(shipments, 'shipmentLines', { actor })
  trace('Pivot shipmentLines (forward): return to the shipped contents', { shipments }, packedLines)
  showObjects('Set B: contents of the shipped shipments, including unrelated lots', packedLines)
  const shippedAffected = rt.intersect(lines, packedLines)
  trace('Intersect A ∩ B: affected lines ∩ shipped contents', { A: lines, B: packedLines }, shippedAffected)
  log('SL5 is affected but unshipped; SL6 is shipped but belongs to unrelated L4. Neither survives the intersection.')
  log('\n  Aggregate: sum units on the retained ShipmentLine records')
  showObjects('input', shippedAffected)
  console.table(shippedAffected.objects.map(({ pk, properties }) => ({ line: pk, units: properties.units })))
  const affectedUnits = shippedAffected.objects.reduce((sum, line) => sum + (line.properties.units as number), 0)
  log('Units in evidence:', affectedUnits)
  log('These are 50 shipped units: 10 + 20 + 20. The selected lots contain 60 units including 10 unshipped; the shipped shipments contain 55 including 5 from L4.')

  h('4. Write: record a customer contact task with its evidence')
  const customer = customers.objects[0]
  log('Contact summary:', { customer: customer.pk, lots: lots.objects.map((lot) => lot.pk), shipments: shipments.objects.length, lines: shippedAffected.objects.length, affectedUnits })
  // This is the same evidence set we just intersected and summed.
  const request = {
    customerId: customer.pk, equipmentId: equipment.objects[0].pk, taskId: 'CONTACT-C1', ...window,
    lineIds: shippedAffected.objects.map((line) => line.pk),
    reason: 'Review reinspection and customer contact for potentially affected shipments; product defects are not confirmed',
  }
  log('Selected customer and evidence:', request)
  log('Tasks before execution:', rt.search('ContactTask', { actor }).objects.length)
  log('The selection is unsaved. Execution rechecks the anomaly, window, customer and shipped-line evidence against current records.')
  log('Create task:', rt.execute('createContactTask', request, { actor }))
  log('Task creation sends no message and does not try to hold already shipped products.')

  h('5. Read: inspect the saved task and all its evidence links')
  const task = rt.get('ContactTask', 'CONTACT-C1', { actor })!
  log('Saved contact task:', task)
  for (const link of ['customerContacts', 'contactEquipment', 'contactLots', 'contactLines']) {
    trace(`Traverse ${link}: task → saved evidence`, { task }, rt.traverse(task, link, { actor }))
  }
  log('Next task: use these records to prepare customer contact and review reinspection needs.')

  h('6. Audit log (applied AND rejected attempts)')
  for (const e of rt.auditLog()) {
    log(`  #${e.seq} ${e.status.padEnd(8)} ${e.action}(${e.target}) by ${e.actor}${e.error ? ` — ${e.error.code}` : ''}`)
  }
} finally {
  app.close()
}
