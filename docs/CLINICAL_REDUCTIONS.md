# Clinical reduction review

Planned appointment edits are measured against the patient's active service
requirement in the patient's timezone. A scheduler's edit enters clinical
review when it lowers the source week's scheduled care and either:

- leaves the service below its `target_hours_per_week`; or
- removes the final visit for a service marked `required`.

Routine provider, room, and within-week time changes remain immediate when they
preserve weekly care. A clinical supervisor may apply a threshold-crossing edit
directly because that role holds `schedule.approve_reduction`.

## Review lifecycle

1. The scheduler submits the ordinary appointment edit form with a reason.
2. Postgres locks the appointment and calculates the source week's before and
   after minutes from current records.
3. If review is required, the appointment is not changed. An
   `appointment_reduction_requests` row, audit event, and generic work-queue
   notification are created atomically.
4. An assigned clinical supervisor opens `/reductions`, reviews the exact
   appointment times and weekly totals, and approves or rejects with a reason.
5. Approval locks both records and verifies the appointment's `updated_at`
   value. A changed appointment makes the request `STALE`; no proposal is
   applied. A current proposal and its resource changes commit in the same
   transaction as the decision and audit event.

The request table is RLS-scoped. Schedulers can track organisation-wide
scheduling work; clinical supervisors see only patients on their active care
team. Authenticated clients have no direct insert, update, or delete access.

## Cancellations

A real patient cancellation is an operational event and is never held back
waiting for approval. It continues through Schedule Recovery immediately.
Required or protected visits carry `requires_clinical_review`, so only an
assigned clinical supervisor can close the case without replacement. Planned
appointment shortening or cross-week moves use the reduction-review workflow
described above.

## Policy still requiring client confirmation

The implementation follows the proposed rule that only clinical supervisors
approve reductions below target. Before production use, Baker Street must
confirm that role assignment and decide whether the threshold should use the
clinical target, the clinical minimum, or another approved policy.
