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
  Draft: "bg-muted-foreground/15 text-muted-foreground border-muted-foreground/20",
  draft: "bg-muted-foreground/15 text-muted-foreground border-muted-foreground/20",
  // lowercase aliases (new domain enums)
  active: "bg-success/15 text-success border-success/30",
  completed: "bg-success/15 text-success border-success/30",
  approved: "bg-success/15 text-success border-success/30",
  operational: "bg-success/15 text-success border-success/30",
  synced: "bg-success/15 text-success border-success/30",
  delivered: "bg-success/15 text-success border-success/30",
  scheduled: "bg-amber-brand/15 text-amber-brand border-amber-brand/40",
  pending: "bg-amber-brand/15 text-amber-brand border-amber-brand/40",
  maintenance: "bg-amber-brand/15 text-amber-brand border-amber-brand/40",
  medium: "bg-amber-brand/15 text-amber-brand border-amber-brand/40",
  delayed: "bg-danger/15 text-danger border-danger/30",
  rejected: "bg-danger/15 text-danger border-danger/30",
  failed: "bg-danger/15 text-danger border-danger/30",
  // PR ordered: distinct from approved (green) so admins can tell at a glance
  // which approved PRs still need a supplier order placed vs. which are
  // already fully reconciled.
  Ordered: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  ordered: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  high: "bg-danger/15 text-danger border-danger/30",
  low: "bg-muted text-muted-foreground border-border",
  inactive: "bg-muted text-muted-foreground border-border",
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium border",
        map[status] || "bg-muted text-muted-foreground border-border",
        className,
      )}
    >
      {status}
    </span>
  );
}
