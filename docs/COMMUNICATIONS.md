# Communications and consent

The communications feature manages patient and guardian contact relationships,
channel consent, appointment reminders, and schedule-recovery outreach. It is
mobile-first and starts in record-only mode so staff can test without sending a
real SMS or email.

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

## Enabling live delivery

Live delivery requires an approved SMS/email provider, the appropriate business
associate agreement, provider credentials stored only in the worker environment,
verified sending identities, signed webhook validation, monitoring, and an
operator runbook. Do not place provider credentials in the Next.js client or
enable live mode before the staging delivery tests pass.
