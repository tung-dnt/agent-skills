---
id: t01-webhook-route
story: shipment-tracking
status: done
depends_on: []
design_refs: [C5, C6]
owner:
---

## Task t01-webhook-route: Webhook route stores carrier events

**Acceptance criteria:**
- [x] Signed carrier POST is stored in `shipment_events` and returns 202

**Verification:**
- [x] Tests pass: `node --test`

**Files likely touched:**
- `src/webhooks.js`

## Design

## Log
