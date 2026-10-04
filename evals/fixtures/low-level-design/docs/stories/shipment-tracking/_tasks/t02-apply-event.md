---
pm-task: true
projectId: "[[shipment-tracking|Shipment tracking]]"
parentId:
id: d9f4a6e2mgcu4h3b
title: "T02 apply event"
type: task
status: todo
priority: medium
start: ""
due: ""
progress: 0
assignees: []
tags:
  - story/shipment-tracking
subtaskIds: []
dependencies:
  - "[[t01-webhook-route|T01 webhook route]]"
createdAt: 2026-09-01T09:00:00.000Z
updatedAt: 2026-09-01T09:00:00.000Z
customFields:
  design_refs: "C3, C4, C5, C6"
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

## Summary

## Checklist

## Log

Project: [[shipment-tracking|Shipment tracking]]
