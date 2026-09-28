---
epic: shipments
---
# Plan: Shipment tracking

## Task Index
Status lives in each task file, never here.

| Id | Task | Depends on | Design refs |
|----|------|------------|-------------|
| t01-webhook-route | Webhook route stores carrier events | — | C5, C6 |
| t02-apply-event | Worker applies a stored event to the shipment status | t01 | C3, C4, C5, C6 |
| t03-status-read | Customer status endpoint (FR2, NFR1, NFR3) | t02 | — |
