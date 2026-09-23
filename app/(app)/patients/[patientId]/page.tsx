import { redirect } from "next/navigation";

/**
 * A patient's record is their week. Rather than duplicate the schedule view,
 * this sends through to it — one place where a patient's time is rendered.
 */
export default async function PatientRecordPage({
  params,
  searchParams,
}: {
  params: Promise<{ patientId: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  const { patientId } = await params;
  const { week } = await searchParams;
  redirect(`/schedule/patient/${patientId}${week ? `?week=${week}` : ""}`);
}
