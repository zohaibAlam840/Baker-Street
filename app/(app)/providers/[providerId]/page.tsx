import { redirect } from "next/navigation";

export default async function ProviderRecordPage({
  params,
  searchParams,
}: {
  params: Promise<{ providerId: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  const { providerId } = await params;
  const { week } = await searchParams;
  redirect(`/schedule/provider/${providerId}${week ? `?week=${week}` : ""}`);
}
