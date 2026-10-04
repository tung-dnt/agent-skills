---
pm-task: true
projectId: "[[shipment-tracking|Shipment tracking]]"
parentId:
id: b3n8w1c5mgcu4h3a
title: "T01 webhook route"
type: task
status: done
priority: medium
start: ""
due: ""
progress: 100
assignees: []
tags:
  - story/shipment-tracking
subtaskIds: []
dependencies: []
createdAt: 2026-09-01T09:00:00.000Z
updatedAt: 2026-09-02T15:30:00.000Z
completed: 2026-09-02
customFields:
  design_refs: "C5, C6"
---

## Task t01-webhook-route: Webhook route stores carrier events

**Acceptance criteria:**
- [x] Signed carrier POST is stored in `shipment_events` and returns 202

**Verification:**
- [x] Tests pass: `node --test`

**Files likely touched:**
- `src/webhooks.js`

## Design

## Summary

## Checklist

## Log

Project: [[shipment-tracking|Shipment tracking]]
