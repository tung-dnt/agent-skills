# Plan: Shipment tracking

## Ordered task index

This plan is static context. The main session owns execution order and file ownership; native todo is the only mutable progress list.

| ID | Task | Depends on | Design refs | Static brief |
|----|------|------------|-------------|--------------|
| t01-webhook-route | Webhook route stores carrier events | — | C5, C6 | [t01](../../../artifacts/t01-webhook-route.md) |
| t02-apply-event | Worker applies a stored event to shipment status | t01-webhook-route | C3, C4, C5, C6 | [t02](../../../artifacts/t02-apply-event.md) |
| t03-status-read | Customer status endpoint | t02-apply-event | — | [t03](../../../artifacts/t03-status-read.md) |
