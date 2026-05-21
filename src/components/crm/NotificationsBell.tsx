import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useData } from "@/contexts/DataContext";
import { useAuth } from "@/contexts/AuthContext";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Bell, CheckCircle2, AlertTriangle, Briefcase, Settings } from "lucide-react";

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const { user } = useAuth();
  const { notifications } = useData();
  const mine = notifications.filter((n) => n.userId === user.id);
  const unread = mine.filter((n) => !n.readAt).length;

  const iconFor = (t: string) => {
    if (t === "approval") return CheckCircle2;
    if (t === "alert") return AlertTriangle;
    if (t === "job") return Briefcase;
    return Settings;
  };
  const colorFor = (t: string) => {
    if (t === "approval") return "text-success bg-success/10";
    if (t === "alert") return "text-danger bg-danger/10";
    if (t === "job") return "text-amber-brand bg-amber-brand/10";
    return "text-muted-foreground bg-muted";
  };

  return (
    <>
      <button onClick={() => setOpen(true)} className="relative p-2 rounded-md hover:bg-accent">
        <Bell className="w-5 h-5" />
        {unread > 0 && (
          <span className="absolute top-1 right-1 min-w-[18px] h-[18px] px-1 grid place-items-center text-[10px] font-bold rounded-full bg-danger text-danger-foreground">
            {unread}
          </span>
        )}
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Notifications</SheetTitle>
          </SheetHeader>
          <div className="mt-4 space-y-2">
            {mine.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-10">
                You're all caught up.
              </p>
            )}
            {mine.map((n) => {
              const Icon = iconFor(n.type);
              return (
                <Link
                  key={n.id}
                  to={n.link ?? "/"}
                  onClick={() => setOpen(false)}
                  className={`block rounded-lg border p-3 ${n.readAt ? "border-border bg-card" : "border-amber-brand/40 bg-amber-brand/5"}`}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={`w-8 h-8 rounded-full grid place-items-center ${colorFor(n.type)}`}
                    >
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{n.body}</p>
                      <p className="text-[10px] font-mono text-muted-foreground mt-0.5">
                        {new Date(n.createdAt).toLocaleString()}
                      </p>
                    </div>
                    {!n.readAt && (
                      <span className="w-2 h-2 rounded-full bg-amber-brand mt-1.5 shrink-0" />
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
