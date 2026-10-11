import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Reminder reconciliation is deliberately best-effort. Appointment writes are
 * authoritative and must never roll back because the communications queue is
 * unavailable. The worker repeats this reconciliation on a schedule.
 */
export async function reconcileAppointmentReminders(
  supabase: SupabaseClient,
  appointmentIds: readonly string[],
): Promise<void> {
  const uniqueIds = [...new Set(appointmentIds.filter(Boolean))];
  for (let offset = 0; offset < uniqueIds.length; offset += 10) {
    const chunk = uniqueIds.slice(offset, offset + 10);
    await Promise.allSettled(
      chunk.map((appointmentId) =>
        supabase.rpc("sync_appointment_reminders", {
          p_appointment_id: appointmentId,
        }),
      ),
    );
  }
}

export async function reconcileUpcomingAppointmentReminders(
  supabase: SupabaseClient,
  horizonDays = 31,
  limit = 200,
) {
  return supabase.rpc("sync_upcoming_appointment_reminders", {
    p_horizon_days: horizonDays,
    p_limit: limit,
  });
}
