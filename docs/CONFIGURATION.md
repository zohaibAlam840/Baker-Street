# Configuration writes

Service, location, room, and equipment configuration is stored in Supabase and
may be committed only by an active `ADMIN` account. Operations users retain a
read-only resource view; application checks and database row-level security
both enforce the write boundary.

## Commands

The configuration screens invoke three database commands through authenticated
server actions:

- `update_location_configuration`
- `update_resource_configuration`
- `update_service_configuration`

The service command updates the service row, active duration set, optimization
objective, and allowed resources in one transaction. A failure rolls back the
entire change.

Every inserted, updated, or removed row in `locations`, `resources`, `services`,
`service_durations`, and `service_resources` is copied into the immutable audit
stream with the authenticated actor.

## Safety checks

In addition to input validation in the server action, the database refuses
configuration changes that would make an existing future booking invalid. This
includes:

- deactivating a location or resource that has future appointments;
- moving a resource away from the location of a future appointment;
- reducing resource capacity below future concurrent use;
- removing a duration currently used by a future visit;
- disabling a delivery mode used by a future visit;
- requiring authorization when a future visit has no authorization; and
- selecting required resources that are absent from a future in-person visit.

Apply `supabase/migrations/20261021010000_configuration_writes.sql` before
deploying the matching application build. The health endpoint requires schema
version `20261022040000` and reports `configuration_writes: true` only when the
commands are installed. That later schema version also includes optimizer plan
decisions, provider communications delivery, and atomic one-visit optimizer
moves, clinical reduction review, and planned provider time off.
