# Venzy Payment API (Pix)

Backend scaffold for Venzy Premium: **R$ 19,90 for 30 days** using Mercado Pago Pix. The repository's HTML app is currently a local-first app and does not have user accounts; secure live payments require deploying this API and integrating a real login/session system before launch.

## What this API does
- Creates a Pix payment through Mercado Pago's Payments API at a fixed amount of BRL 19.90.
- Requires a signed JWT bearer token for payment creation and plan-status requests. The `sub` claim is the authenticated Venzy user ID.
- Validates Mercado Pago webhook signatures using HMAC-SHA256.
- Fetches each notified payment from Mercado Pago's API instead of trusting the webhook payload.
- Grants 30 days only for approved payments matching the expected amount and authenticated user reference.
- Stores payment records and entitlements in PostgreSQL.

## Required before production
1. Deploy this API to a server with HTTPS and persistent PostgreSQL.
2. Configure environment variables from `.env.example`. Keep all credentials on the server; never put the access token, webhook secret, or JWT secret in HTML/Android assets or Git.
3. Create a Mercado Pago application in the account of the responsible account holder, obtain its access token, and configure the webhook URL as `https://YOUR_API_HOST/api/webhooks/mercadopago` for payment events. Copy the webhook signing secret into `MERCADOPAGO_WEBHOOK_SECRET`.
4. Add the Venzy account/login service that issues JWTs signed with `JWT_SECRET`. Do not use a shared/static token or accept a user ID supplied by the client as proof of identity.
5. Connect the app's Premium screen to this API using the authenticated session. Show the returned Pix QR code / copy-and-paste code, then poll `GET /api/payments/status` with the same authenticated session.
6. Test with Mercado Pago test credentials and test webhooks before switching to production credentials. Confirm cancellation, duplicate notifications, wrong amounts, rejected payments, and expiration behavior.
7. Review the subscription and privacy terms before accepting real payments.

## Endpoints
- `GET /health` — health check.
- `POST /api/payments/pix` — requires `Authorization: Bearer <JWT>`; JSON body: `{ "email": "...", "firstName": "..." }`.
- `GET /api/payments/status` — requires the same bearer authentication; returns premium state and expiration.
- `POST /api/webhooks/mercadopago` — public endpoint, but verifies the Mercado Pago signature and fetches the payment independently.

## Important limitation
This is not a live payment system until it is deployed, credentials and webhook are configured, and the app's real authentication is integrated. The current Venzy HTML stores its appointments and profile locally, so this backend intentionally does not treat localStorage or a client-supplied user ID as secure identity.
