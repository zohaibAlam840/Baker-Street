# CP-SAT scheduling service

The optional service under `services/cp_sat_solver` uses Google OR-Tools to
optimize all configured patient services together. It is a private compute
worker, not an authority: it cannot read the database or write schedules.

## Security boundary

Next.js generates candidates through the existing rule engine and sends only
one-way candidate tokens, opaque service, provider, and authorization IDs plus integer slots,
ceilings, objectives, and incompatibility indexes. The payload excludes patient
identifiers, names, contacts, diagnoses, free text, location IDs, resource IDs,
and database credentials. Requests use a server-only bearer secret of at least
24 characters.

Returned candidate IDs are schema-checked, rejected if unknown or duplicated,
and re-evaluated together with the TypeScript rule engine. Approval still
reloads current RLS-scoped data and uses the existing atomic Postgres function.

## Configuration

Deploy the Docker image from `services/cp_sat_solver` behind HTTPS, preferably
with private ingress. Configure the same secret in the service and application:

```text
CP_SAT_SOLVER_URL=https://private-solver.example.org
CP_SAT_SOLVER_SECRET=<random secret, at least 24 characters>
CP_SAT_REQUIRED=false
CP_SAT_TIMEOUT_MS=9000
CP_SAT_MAX_CANDIDATES=4000
CP_SAT_TIME_LIMIT_SECONDS=8
```

Keep `CP_SAT_REQUIRED=false` during rollout. In that mode, configuration,
network, timeout, non-2xx, schema, or rule-revalidation failures produce a
PHI-free error code and fall back to the deterministic local optimizer. Set it
to `true` only after redundant service instances and alerting are proven; a
solver failure then blocks generation rather than silently falling back.

The application health endpoint reports `solver` as `unconfigured`,
`available`, `degraded`, or `unavailable`. Overall health fails on solver status
only when `CP_SAT_REQUIRED=true`.

## Proof boundary

`optimality_proven` is true only when OR-Tools reports `OPTIMAL`, candidate
generation was not truncated, reduction did not hit its cap, and the leading
plan came from CP-SAT. One-visit move rescue remains bounded and is never folded
into that proof. The service does not cancel care, reduce care, chain moves, or
modify protected/locked visits.
