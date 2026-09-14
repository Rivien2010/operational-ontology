/** Run: pnpm demo:factory. Source databases and the store are reset in memory. */
import { integrate } from './integrate.js'
import { createFactory } from './runtime.js'

const app = createFactory()
const { rt } = app
const actor = 'user:factory-ops'
const window = { after: '2026-09-06T00:00:00+09:00', before: '2026-09-07T00:00:00+09:00' }
try {
  console.log('September 8: an equipment inspection found an anomaly. Release inspections had passed; goods shipped September 7.')
  console.log('September 6 is the supplied investigation window, not an inferred failure interval.')
  const equipment = rt.filter(rt.search('Equipment', { actor }), (object) => object.properties.inspection === 'anomaly')
  const produced = rt.pivot(equipment, 'producedOn', { actor })
  const lots = rt.filter(produced, (object) => {
    const time = Date.parse(object.properties.manufacturedAt as string)
    return time >= Date.parse(window.after) && time < Date.parse(window.before)
  })
  const lines = rt.pivot(lots, 'lotLines', { actor })
  const shipments = rt.filter(rt.pivot(lines, 'shipmentLines', { actor }), (object) => object.properties.status === 'shipped')
  const customers = rt.pivot(shipments, 'customerShipments', { actor })
  for (const [step, set] of Object.entries({ equipment, produced, lots, lines, shipments, customers })) {
    console.log(step, set.type, set.objects.map((o) => o.pk), `(${set.objects.length})`)
  }
  console.log('S1 and S2 converge on C1. C2 is excluded because its L2 was made September 5.')
  console.log('C3 has only an unshipped part of L1. The unrelated L4 packed in S1 is not evidence.')
  console.log('Manufactured units by family:', rt.aggregate(lots, { groupBy: 'family', sum: 'units' }).values)
  const impact = rt.call('customerImpact', { lotIds: lots.objects.map((lot) => lot.pk) }, { actor })
  console.log('Affected shipped quantities, at shipment-line grain:')
  console.table(impact.aggregation.values.map(({ key, metrics }) => ({ key, ...metrics })))
  const customer = customers.objects[0]
  const evidence = impact.evidence.find((e) => e.customerId === customer.pk)!
  const request = {
    customerId: customer.pk, equipmentId: equipment.objects[0].pk, taskId: 'CONTACT-C1', ...window,
    lineIds: evidence.lines.objects.map((line) => line.pk),
    reason: 'Review reinspection and customer contact for potentially affected shipments; product defects are not confirmed',
  }
  console.log('Preview:', rt.preview('createContactTask', request, { actor }))
  console.log('Tasks before execution:', rt.search('ContactTask', { actor }).objects.length)
  console.log('Create task:', rt.execute('createContactTask', request, { actor }))
  rt.load(integrate(app.sources))
  const task = rt.get('ContactTask', 'CONTACT-C1', { actor })!
  console.log('Saved evidence after source refresh:', rt.traverse(task, 'contactLines', { actor }))
  console.log('Task creation sends no message and does not try to hold already shipped products.')
  console.log('Audit:', rt.auditLog())
} finally {
  app.close()
}
