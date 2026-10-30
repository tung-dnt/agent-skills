# T02 — Apply event

## Description

The worker updates `shipments.status` and `last_event_time` according to contracts C3/C4 and records the event in history.

## Acceptance criteria

- Valid transitions update status and `last_event_time` and add a history row.
- Out-of-order and ignored transitions follow C3/C4.

## Verification

- Focused tests cover valid, duplicate, out-of-order, invalid, and retry cases.

## Dependencies and design references

- Depends on: t01-webhook-route
- Shared contracts: C3, C4, C5, C6

## Owned paths

- `src/apply-event.js`
- `src/apply-event.test.js`

## Design
