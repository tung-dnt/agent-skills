const { verifySignature } = require('./signatures');

// Task 1 (done): stores the raw event; the worker applies it later.
async function handleCarrierWebhook(req, res, { db, queue }) {
  if (!verifySignature(req.params.carrier, req)) return res.status(401).end();
  const event = {
    carrier: req.params.carrier,
    carrierEventId: req.body.id,
    shipmentId: req.body.shipment_ref,
    status: req.body.status,
    carrierEventTime: new Date(req.body.occurred_at),
  };
  const inserted = await db.insertEventIfNew(event); // unique (carrier, carrier_event_id)
  if (inserted) await queue.publish('shipment_events', event);
  return res.status(202).end();
}

module.exports = { handleCarrierWebhook };
