export default function StatusPill({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const styles =
    normalized === "active" || normalized === "ready" || normalized === "succeeded"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
      : normalized === "failed" || normalized === "revoked" || normalized === "deleted"
        ? "bg-amber-50 text-amber-700 ring-amber-200"
        : "bg-sky-50 text-sky-700 ring-sky-200";
  const label = status
    .split(/[-_\s]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ring-1 ${styles}`}
    >
      {label}
    </span>
  );
}
