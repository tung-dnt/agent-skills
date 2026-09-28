# Spec: Shipment tracking (story ST-12)

FR1 ingest carrier webhooks · FR2 customer views status + history ·
FR3 statuses LABEL_CREATED → IN_TRANSIT → OUT_FOR_DELIVERY → DELIVERED (final), EXCEPTION ·
NFR2 event visible within 60 s · NFR3 no cross-account reads.

## Design (approved)

Components: `orders-api` gains a `/webhooks/carriers/:carrier` route that
verifies the carrier signature, writes the event, and returns 202. A
`tracking-worker` consumes `shipment_events` asynchronously and updates
`shipments.status`.

State transitions (C3):

| From \ To        | IN_TRANSIT | OUT_FOR_DELIVERY | DELIVERED | EXCEPTION |
|------------------|-----------|------------------|-----------|-----------|
| LABEL_CREATED    | apply     | apply            | apply     | apply     |
| IN_TRANSIT       | ignore    | apply            | apply     | apply     |
| OUT_FOR_DELIVERY | ignore    | ignore           | apply     | apply     |
| DELIVERED        | ignore+log| ignore+log       | ignore    | ignore+log|
| EXCEPTION        | apply     | apply            | apply     | ignore    |

Ordering rule (C4): apply an event only if its `carrier_event_time` is newer
than `shipments.last_event_time`; older events are stored in history but do
not change status.

Idempotency (C5): `shipment_events` has a unique key
`(carrier, carrier_event_id)`. A duplicate insert is a no-op and still returns 202.

Partial write (C6): the webhook inserts the event, then publishes it. If the
publish fails, the row keeps `published_at = NULL` and a sweeper republishes
unpublished rows every minute. The queue delivers at least once, so the worker
can receive the same event more than once.
