/** Run: pnpm demo:factory. Source databases and the store are reset in memory. */
import { integrate } from './integrate.js'
import { createFactory } from './runtime.js'
import { heading as h, log, showObjects, trace } from '../demo-output.js'

const app = createFactory()
const { rt } = app
const actor = 'user:factory-ops'
const window = { after: '2026-09-06T00:00:00+09:00', before: '2026-09-07T00:00:00+09:00' }
try {
  h('1. Read: an inspection finding sets the investigation scope')
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
  const shippedAffected = rt.intersect(lines, packedLines)
  trace('Intersect: affected lines ∩ shipped contents', { affectedLines: lines, packedLines }, shippedAffected)
  log('SL5 is affected but unshipped; SL6 is shipped but belongs to unrelated L4. Neither survives the intersection.')
  const manufactured = rt.aggregate(lots, { groupBy: 'family', sum: 'units' })
  log('\n  Aggregate: group selected lots by family, count lots and sum manufactured units')
  showObjects('input', lots)
  console.table(manufactured.values.map(({ key, pks, metrics }) => ({ family: key, lots: pks.join(', '), ...metrics })))
  log('\n  Function customerImpact: calculate shipped quantities and retain their evidence')
  log('    params:', { lotIds: lots.objects.map((lot) => lot.pk) })
  const impact = rt.call('customerImpact', { lotIds: lots.objects.map((lot) => lot.pk) }, { actor })
  showObjects('customers', impact.aggregation.set)
  console.table(impact.aggregation.values.map(({ key, metrics }) => ({ key, ...metrics })))
  for (const row of impact.evidence) showObjects(`evidence for ${row.customerId}`, row.lines)
  log('The 60 manufactured units and 50 affected shipped units answer different questions; quantities retain their original record grain.')

  h('4. Write: record a customer contact task with its evidence')
  const customer = customers.objects[0]
  const evidence = impact.evidence.find((e) => e.customerId === customer.pk)!
  const request = {
    customerId: customer.pk, equipmentId: equipment.objects[0].pk, taskId: 'CONTACT-C1', ...window,
    lineIds: evidence.lines.objects.map((line) => line.pk),
    reason: 'Review reinspection and customer contact for potentially affected shipments; product defects are not confirmed',
  }
  log('Selected customer and evidence:', request)
  log('Tasks before execution:', rt.search('ContactTask', { actor }).objects.length)
  log('Create task:', rt.execute('createContactTask', request, { actor }))
  log('Task creation sends no message and does not try to hold already shipped products.')

  h('5. Re-index: the task and its evidence links survive')
  rt.load(integrate(app.sources))
  const task = rt.get('ContactTask', 'CONTACT-C1', { actor })!
  const savedLines = rt.traverse(task, 'contactLines', { actor })
  trace('Traverse contactLines (forward): ContactTask → ShipmentLine', { task }, savedLines)
  log('Saved evidence after source refresh:', savedLines)

  h('6. Audit log (applied AND rejected attempts)')
  for (const e of rt.auditLog()) {
    log(`  #${e.seq} ${e.status.padEnd(8)} ${e.action}(${e.target}) by ${e.actor}${e.error ? ` — ${e.error.code}` : ''}`)
  }
} finally {
  app.close()
}
