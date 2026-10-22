# Provider time off

Planned provider absences use a request and approval workflow. They are kept
separate from urgent callouts so a future request cannot silently change the
live schedule before scheduling staff review its operational impact.

## Workflow

1. A signed-in Provider linked to an active clinician record opens `/time-off`,
   enters a future window of up to 14 days, chooses PTO, training, or other,
   adds an operational note, and confirms the request.
2. The request remains `PENDING`. It does not block availability or cancel an
   appointment. Schedulers receive a privacy-safe work-queue notification.
3. A Scheduler reviews the exact window and records an approval or rejection
   reason. The expected row version prevents a stale double decision.
4. Rejection closes the request without changing the schedule. Approval calls
   the existing atomic provider-callout transaction: it creates the disruption,
   cancels overlapping scheduled or confirmed visits, preserves their original
   state in recovery cases, creates audit history, and notifies schedulers.
5. A Provider may withdraw only their own pending request. An approved absence
   is managed through schedule recovery, where the existing guarded callout
   withdrawal restores eligible future visits atomically.

Urgent illness and emergency reporting remains at `/recovery`; it takes effect
immediately and therefore requires an explicit cancellation confirmation.

## Security boundaries

- Providers can read only requests for their linked clinician record.
- Schedulers can read and decide all requests.
- No role receives direct insert, update, or delete access to the request table;
  all mutations go through audited security-definer commands.
- Direct authenticated writes to recurring `provider_availability` are removed.
  This prevents a provider from bypassing approval by editing their own hours.
- Request and decision notes are operational fields and must not contain patient
  information.
- Duplicate mobile submissions use actor-scoped idempotency keys. Pending
  requests for the same provider cannot overlap.

## Client decisions still required

Before production, the client should confirm:

- whether Scheduler is the final approver or manager/HR approval is also needed;
- the normal minimum notice period and any blackout dates;
- whether the 14-day limit is correct or longer leave belongs in a separate
  process; and
- which absence categories and reporting fields are required for policy and
  payroll, without placing sensitive medical details in this scheduling tool.

## Release verification

Apply `20261022020000_provider_time_off_requests.sql` followed by
`20261022030000_provider_callout_guard.sql`. The health endpoint then requires
schema version `20261022040000`, the `provider_time_off` capability, and the
self-reported callout guard. Run the pgTAP access suite and the staging drill
in `docs/PRODUCTION_RUNBOOK.md` before routing production traffic to the build.
