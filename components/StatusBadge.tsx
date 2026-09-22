import type { Status } from "@/lib/types";

const TEXT: Record<Status, string> = { OK: "No mismatch detected", MISMATCH: "Mismatch", NEEDS_REVIEW: "Needs review" };

export default function StatusBadge({ status, label }: { status: Status; label?: string }) {
  return <span className={`badge ${status.toLowerCase()}`}>{label ?? TEXT[status]}</span>;
}
