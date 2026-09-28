# Spec: Shipment tracking (story ST-12)

As a customer, I want to see where my order is so I stop contacting support.

## Existing system
- `orders-api` (Node, Postgres `orders` table) serves the storefront. Orders
  belong to one customer account; every read is scoped to the caller's account.
- Two carriers (FastShip, ParcelCo) can POST webhooks. They retry on any
  non-2xx for up to 24 hours and may deliver events late or twice.
- A Redis instance is already provisioned for session storage.

## Functional requirements
- FR1: Ingest carrier status webhooks for orders we shipped.
- FR2: Customer can view the current shipment status and its history.
- FR3: Statuses are LABEL_CREATED, IN_TRANSIT, OUT_FOR_DELIVERY, DELIVERED,
  EXCEPTION. DELIVERED is final.
- FR4: Email the customer when the status becomes OUT_FOR_DELIVERY.

## Non-functional requirements
- NFR1: 95% of status reads complete in under 200 ms.
- NFR2: A carrier event is visible to the customer within 60 seconds.
- NFR3: A customer can never read another account's shipment.
- NFR4: Tracking history is kept 13 months, then deleted.

## Out of scope (from product)
- Carrier rate shopping, returns, SMS notifications.
