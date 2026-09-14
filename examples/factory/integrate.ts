/** Normalize MES production history and WMS fulfilment into one snapshot. */
import type { FactoryDbs } from './fixtures.js'

export function integrate({ mes, wms }: FactoryDbs) {
  const rows = (db: FactoryDbs['mes'], sql: string) => db.prepare(sql).all() as Record<string, unknown>[]
  const pairs = (db: FactoryDbs['mes'], sql: string) =>
    db.prepare(sql).raw().all() as [string, string][]
  return {
    objects: {
      Equipment: rows(mes, 'SELECT id, inspection, inspected_at AS inspectedAt FROM equipment'),
      Lot: rows(mes, 'SELECT id, family, units, manufactured_at AS manufacturedAt, release_inspection AS releaseInspection FROM lot'),
      Customer: rows(wms, 'SELECT id, name, region FROM customer'),
      Shipment: rows(wms, 'SELECT id, status, shipped_at AS shippedAt FROM shipment'),
      // Quantity belongs to a shipment line, not to a bare Lot → Shipment link.
      ShipmentLine: rows(wms, 'SELECT id, units FROM shipment_line'),
    },
    links: {
      producedOn: pairs(mes, 'SELECT equipment_id, lot_id FROM production'),
      lotLines: pairs(wms, 'SELECT lot_id, id FROM shipment_line'),
      shipmentLines: pairs(wms, 'SELECT shipment_id, id FROM shipment_line'),
      customerShipments: pairs(wms, 'SELECT customer_id, id FROM shipment'),
    },
  }
}
