# Communications and consent

The communications feature manages patient and guardian contact relationships,
channel consent, appointment reminders, and schedule-recovery outreach. It is
mobile-first and starts in record-only mode so staff can test without sending a
real SMS or email. The server-only delivery worker supports Twilio SMS and
Twilio SendGrid email after a deployment operator completes the release gate.

## Staff workflow

1. A Scheduler records the contact, relationship, legal authority where
   applicable, effective dates, timezone, language, quiet hours, and confirms
   that the relationship was verified.
2. Consent is recorded independently for each channel. A prior opt-out,
   complaint, unsubscribe, or hard bounce requires an explicit verified
   re-consent source before that channel can be granted again.
3. A Scheduler queues an appointment reminder or recovery message. Automatic
   appointment reminders use only the verified primary contact.
4. Staff monitor the communications queue. Failed retryable jobs can be retried;
   stale, changed, withdrawn, answered, expired, or revoked messages are
   suppressed or cancelled.
5. A recovery response records the exact offer, contact, response channel, and
   originating communication job so the decision has auditable provenance.

## Access model

- Scheduler: manage contacts and consent, queue/retry/cancel messages, view
  communications for permitted patients.
- Clinical: read communications only for an active care-team caseload.
- Compliance: read sanitized consent events and delivery history without raw
  destinations or message content.
- Operations: read aggregate communication counts only.
- Provider, Authorization, and Admin: no raw communications access.
- External delivery worker: service-role RPC boundary only; no browser access.

Postgres RLS and RPC authorization enforce these rules. UI visibility is only a
convenience layer.

## Privacy and delivery rules

- Raw phone numbers, email addresses, push endpoints, subjects, and message
  bodies are hidden outside the narrow Scheduler/Clinical scope.
- Templates intentionally contain no patient name, diagnosis, service, clinician,
  location, or appointment time.
- A worker receives the destination and body only after a second, just-in-time
  validation of contact authority, relationship dates, consent, source record,
  quiet hours, and expiry.
- Provider events are replay-safe. Temporary failures use bounded exponential
  backoff, terminal delivery cannot be regressed by late callbacks, and STOP,
  complaints, and hard bounces revoke future use of the channel.
- Contact changes, consent changes, appointment changes/cancellation, withdrawn
  recovery offers, and completed recovery responses invalidate pending work.

## Delivery architecture

`GET /api/communications/deliver` is a bounded worker endpoint authenticated by
`Authorization: Bearer $CRON_SECRET`. Each invocation:

1. verifies that the environment gate is enabled and the database gate is
   `LIVE` before it leases any work;
2. reconciles upcoming reminder jobs and releases expired leases;
3. claims no more than `COMMUNICATIONS_BATCH_SIZE` jobs, and only channels with
   a complete provider configuration;
4. calls `prepare_communication_provider_delivery` immediately before each
   provider request; and
5. records the immutable attempt and its retryable, permanent, accepted, or
   delivered outcome through the service-role RPC boundary.

The preparation RPC is the only worker call that returns a raw destination or
message body. It repeats consent, recipient authority, effective-date, source,
suppression, quiet-hours, expiry, and delivery-mode checks. Receipt correlation
uses a separate opaque token table that authenticated application roles cannot
read. Worker responses and logs contain counts and bounded error codes only.

Twilio callbacks are accepted at
`POST /api/communications/webhooks/twilio`. The worker includes that signed URL
as each message's status callback. Configure the same URL, without a token, as
the Messaging Service inbound webhook and enable Advanced Opt-Out so `STOP`
events include `OptOutType`. `START` never grants consent automatically; staff
must verify and record re-consent in the application.

SendGrid events are accepted at
`POST /api/communications/webhooks/sendgrid`. Configure a Signed Event Webhook
for `processed`, `deferred`, `delivered`, `bounce`, `dropped`, `spam report`,
`unsubscribe`, and `group unsubscribe`. The handler verifies the signature
against the unmodified raw request body and ignores account-wide events that do
not carry this application's opaque receipt token. Open and click tracking are
disabled by the sender and engagement events are ignored.

## Enabling live delivery

Live delivery requires an approved provider, the appropriate business associate
agreement, provider credentials stored only in the server environment, verified
sending identities, signed webhook validation, monitoring, and staging tests.
Do not place provider credentials in the Next.js client.

Required worker values are documented in `.env.example`. At least one complete
provider configuration is required. `COMMUNICATIONS_PUBLIC_BASE_URL` must be the
exact public HTTPS origin used by provider callbacks. The worker supports:

- SMS: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and preferably
  `TWILIO_MESSAGING_SERVICE_SID` (or `TWILIO_FROM_NUMBER`).
- Email: `SENDGRID_API_KEY`, verified `SENDGRID_FROM_EMAIL`, optional sender
  name, `SENDGRID_REGION`, and `SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY`.

Enable in this order:

1. Keep `COMMUNICATIONS_DELIVERY_ENABLED=false` and the database row in
   `RECORD_ONLY` while applying migrations and configuring signed webhooks.
2. Exercise accepted, delivered, temporary failure, permanent failure, STOP,
   complaint, hard-bounce, duplicate, and out-of-order callbacks in staging.
3. Confirm no destination, body, subject, provider secret, or raw provider
   response appears in application logs or sanitized attempt/receipt metadata.
4. As the database deployment operator, set the singleton
   `communication_delivery_config.delivery_mode` to `LIVE`, with `updated_at`
   and `updated_by` recorded.
5. Set `COMMUNICATIONS_DELIVERY_ENABLED=true`, then register the authenticated
   worker route with a five-minute scheduler. Vercel Cron can call the GET route
   and automatically sends `CRON_SECRET`; do not register a schedule more
   frequent than the hosting plan supports.

Either gate stops new provider sends. Delayed signed receipts remain active when
the worker gate is disabled so delivery and opt-out state can still converge.
