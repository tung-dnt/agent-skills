# Plan: Shipment tracking (ST-12)

## Task 1: Webhook route stores carrier events (done)
- Acceptance: signed carrier POST is stored in `shipment_events` and returns 202
- Verify: `node --test`
- Files: src/webhooks.js

## Task 2: Worker applies a stored event to the shipment status
- Acceptance: the worker updates `shipments.status` and `last_event_time`
  according to design C3/C4, and records the event in history
- Dependencies: Task 1
- Design refs: C3, C4, C5, C6
- Verify: `node --test`
- Files: src/apply-event.js, src/apply-event.test.js

## Task 3: Customer status endpoint (FR2, NFR1, NFR3)
- Acceptance: GET /orders/:id/shipment returns status + history for the caller's own order
- Files: src/shipment-read.js
