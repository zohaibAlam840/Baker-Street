import { RouteLoading } from "@/components/shell/RouteLoading";

export default function Loading() {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-7xl p-4 sm:p-6">
      <RouteLoading label="Loading Baker Street" variant="overview" />
    </main>
  );
}
