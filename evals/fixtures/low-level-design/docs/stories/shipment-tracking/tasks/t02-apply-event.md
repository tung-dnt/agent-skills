---
id: t02-apply-event
story: shipment-tracking
status: pending
depends_on: [t01-webhook-route]
design_refs: [C3, C4, C5, C6]
owner:
---

## Task t02-apply-event: Worker applies a stored event to the shipment status

**Description:** The worker updates `shipments.status` and `last_event_time` according to design C3/C4 and records the event in history.

**Acceptance criteria:**
- [ ] Valid transitions update status and last_event_time and add a history row
- [ ] Out-of-order and ignored transitions follow C3/C4

**Verification:**
- [ ] Tests pass: `node --test`

**Files likely touched:**
- `src/apply-event.js`
- `src/apply-event.test.js`

## Design

## Log
