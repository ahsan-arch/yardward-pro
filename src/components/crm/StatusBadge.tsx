import { cn } from "@/lib/utils";

const map: Record<string, string> = {
  Active: "bg-success/15 text-success border-success/30",
  Live: "bg-success/15 text-success border-success/30",
  Completed: "bg-success/15 text-success border-success/30",
  Approved: "bg-success/15 text-success border-success/30",
  Operational: "bg-success/15 text-success border-success/30",
  Scheduled: "bg-amber-brand/15 text-amber-brand border-amber-brand/40",
  Pending: "bg-amber-brand/15 text-amber-brand border-amber-brand/40",
  "Needs review": "bg-amber-brand/15 text-amber-brand border-amber-brand/40",
  Medium: "bg-amber-brand/15 text-amber-brand border-amber-brand/40",
  "In maintenance": "bg-amber-brand/15 text-amber-brand border-amber-brand/40",
  Delayed: "bg-danger/15 text-danger border-danger/30",
  Rejected: "bg-danger/15 text-danger border-danger/30",
  Urgent: "bg-danger/15 text-danger border-danger/30",
  High: "bg-danger/15 text-danger border-danger/30",
  Inactive: "bg-muted text-muted-foreground border-border",
  Low: "bg-muted text-muted-foreground border-border",
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium border",
      map[status] || "bg-muted text-muted-foreground border-border", className)}>
      {status}
    </span>
  );
}
