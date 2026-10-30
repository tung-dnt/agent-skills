# T01 — Webhook route stores carrier events

## Acceptance criteria

- Signed carrier POST is stored in `shipment_events` and returns 202.

## Verification

- Focused tests cover signature validation, successful persistence, and response status.

## Dependencies and design references

- Depends on: none
- Shared contracts: C5, C6

## Owned paths

- `src/webhooks.js`

## Design
