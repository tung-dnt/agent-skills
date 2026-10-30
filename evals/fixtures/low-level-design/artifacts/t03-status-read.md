# T03 — Customer status endpoint

## Description

Return the shipment status and history for the caller's own order.

## Acceptance criteria

- `GET /orders/:id/shipment` returns status and history for an order the caller owns.
- Requests for another account's order do not disclose shipment information.

## Verification

- Focused tests cover the owned-order response and cross-account denial.

## Dependencies and design references

- Depends on: t02-apply-event
- Shared contracts: none

## Owned paths

- `src/shipment-read.js`

## Design
