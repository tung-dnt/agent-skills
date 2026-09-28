// Thin data-access layer used by every module. Each function takes a
// transaction handle `tx` so callers control transaction boundaries.

async function getShipmentForUpdate(tx, shipmentId) {
  // SELECT id, account_id, status, last_event_time FROM shipments WHERE id = $1 FOR UPDATE
  return tx.one('select_shipment_for_update', [shipmentId]);
}

async function updateShipmentStatus(tx, shipmentId, status, lastEventTime) {
  return tx.none('update_shipment_status', [shipmentId, status, lastEventTime]);
}

async function insertHistory(tx, shipmentId, event) {
  return tx.none('insert_shipment_history', [shipmentId, event.status, event.carrierEventTime]);
}

module.exports = { getShipmentForUpdate, updateShipmentStatus, insertHistory };
