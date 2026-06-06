// /mechanic/messages — mirror of /driver/messages, but the new-conversation
// recipient picker defaults to the driver assigned to the mechanic's current
// MWO (if any) so the most common case — "ask the driver who reported this
// fault" — is one tap.
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { MechanicShell } from "@/components/layout/MechanicLayout";
import { useAuth } from "@/contexts/AuthContext";
import { useData } from "@/contexts/DataContext";
import { ConversationView } from "@/components/crm/ConversationView";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, MessageSquare, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { toast } from "sonner";
import type { ConversationTopic } from "@/types/domain";

function homeForRole(role: string | null): "/admin" | "/driver" | "/mechanic" | "/login" {
  if (role === "admin") return "/admin";
  if (role === "driver") return "/driver";
  if (role === "mechanic") return "/mechanic";
  return "/login";
}

export const Route = createFileRoute("/mechanic/messages")({
  beforeLoad: () => {
    if (typeof window === "undefined") return;
    if (localStorage.getItem("fo:authed") !== "1") {
      throw redirect({ to: "/login" });
    }
    const role = localStorage.getItem("fo:role");
    if (role !== "mechanic") throw redirect({ to: homeForRole(role) });
  },
  head: () => ({ meta: [{ title: "Messages — Yardward Pro" }] }),
  component: Page,
});

function Page() {
  const { user } = useAuth();
  const {
    conversations,
    conversationParticipants,
    messages,
    drivers,
    mechanics,
    maintenanceWorkOrders,
  } = useData();

  const [openConvId, setOpenConvId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  const myConvIds = useMemo(
    () =>
      new Set(
        conversationParticipants
          .filter((p) => p.userId === user.id && p.leftAt === null)
          .map((p) => p.conversationId),
      ),
    [conversationParticipants, user.id],
  );

  const myConvs = useMemo(
    () =>
      conversations
        .filter((c) => myConvIds.has(c.id))
        .sort(
          (a, b) =>
            new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime(),
        ),
    [conversations, myConvIds],
  );

  function unreadCount(convId: string): number {
    const myCp = conversationParticipants.find(
      (p) => p.conversationId === convId && p.userId === user.id && p.leftAt === null,
    );
    if (!myCp) return 0;
    const since = myCp.lastReadAt ? new Date(myCp.lastReadAt).getTime() : 0;
    return messages.filter(
      (m) =>
        m.conversationId === convId &&
        m.senderId !== user.id &&
        new Date(m.createdAt).getTime() > since,
    ).length;
  }

  function counterpartyName(convId: string): string {
    const others = conversationParticipants.filter(
      (p) => p.conversationId === convId && p.userId !== user.id && p.leftAt === null,
    );
    const names = others.map((p) => {
      const d = drivers.find((x) => x.id === p.userId);
      if (d) return d.name.split(" ")[0];
      const m = mechanics.find((x) => x.id === p.userId);
      if (m) return m.name.split(" ")[0];
      return p.userId.slice(0, 4);
    });
    return names.join(", ") || "—";
  }

  // Default driver for new conversation: the driver who reported the current
  // mechanic's most recent assigned MWO. Falls back to drivers[0].
  const defaultCounterpartyId = useMemo(() => {
    const myMwo = maintenanceWorkOrders
      .filter((m) => m.assignedMechanicId === user.id && m.reportedBy)
      .sort(
        (a, b) =>
          new Date(b.createdAt ?? "").getTime() -
          new Date(a.createdAt ?? "").getTime(),
      )[0];
    return myMwo?.reportedBy ?? drivers[0]?.id ?? "";
  }, [maintenanceWorkOrders, user.id, drivers]);

  const openConv = openConvId
    ? conversations.find((c) => c.id === openConvId) ?? null
    : null;
  const openParticipants = openConvId
    ? conversationParticipants.filter((p) => p.conversationId === openConvId)
    : [];
  const openMessages = openConvId
    ? messages
        .filter((m) => m.conversationId === openConvId)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    : [];

  return (
    <MechanicShell title="Messages">
      <div className="p-4 flex items-center justify-between border-b border-border">
        <h1 className="text-lg font-bold">Messages</h1>
        <Button
          size="sm"
          onClick={() => setNewOpen(true)}
          data-testid="mechanic-new-conversation"
          className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
        >
          <Plus className="w-4 h-4" /> New
        </Button>
      </div>

      <div data-testid="mechanic-conversation-list">
        {myConvs.length === 0 && (
          <div className="p-8 text-center text-sm text-muted-foreground">
            <MessageSquare className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p>No conversations yet.</p>
            <p className="text-xs mt-1">Tap New to message a driver.</p>
          </div>
        )}
        {myConvs.map((c) => {
          const unread = unreadCount(c.id);
          return (
            <button
              key={c.id}
              onClick={() => setOpenConvId(c.id)}
              data-testid="mechanic-conv-row"
              data-conv-id={c.id}
              className={cn(
                "w-full text-left p-4 border-b border-border/50 active:bg-muted/50",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold truncate">{c.subject}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">
                    {counterpartyName(c.id)}
                  </p>
                  <p className="text-[10px] capitalize text-muted-foreground mt-0.5">
                    {c.topic}
                    {c.status !== "active" && ` · ${c.status}`}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  {unread > 0 && (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-brand text-amber-brand-foreground font-bold"
                      data-testid="unread-badge"
                    >
                      {unread}
                    </span>
                  )}
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {relativeTime(c.lastMessageAt)}
                  </span>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <Sheet
        open={!!openConvId}
        onOpenChange={(o) => !o && setOpenConvId(null)}
      >
        <SheetContent
          side="right"
          className="w-full sm:max-w-md p-0 flex flex-col"
        >
          <SheetHeader className="p-3 border-b border-border flex flex-row items-center gap-2 sticky top-0 bg-background z-10">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setOpenConvId(null)}
              aria-label="Back"
            >
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <SheetTitle className="text-sm truncate flex-1">
              {openConv?.subject ?? "Conversation"}
            </SheetTitle>
          </SheetHeader>
          <div className="flex-1 min-h-0">
            {openConv && (
              <ConversationView
                key={openConv.id}
                conversation={openConv}
                messages={openMessages}
                participants={openParticipants}
                viewerRole="mechanic"
              />
            )}
          </div>
        </SheetContent>
      </Sheet>

      <NewMechanicConversationDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        defaultDriverId={defaultCounterpartyId}
        onCreated={(id) => setOpenConvId(id)}
      />
    </MechanicShell>
  );
}

function NewMechanicConversationDialog({
  open,
  onOpenChange,
  defaultDriverId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  defaultDriverId: string;
  onCreated: (id: string) => void;
}) {
  const { drivers } = useData();
  const [topic, setTopic] = useState<ConversationTopic>("maintenance");
  const [subject, setSubject] = useState("");
  const [driverId, setDriverId] = useState<string>(defaultDriverId);
  const [busy, setBusy] = useState(false);

  // Keep driverId in sync when defaults change (e.g. new MWO claimed).
  useMemo(() => {
    if (!driverId && defaultDriverId) setDriverId(defaultDriverId);
  }, [defaultDriverId, driverId]);

  function reset() {
    setTopic("maintenance");
    setSubject("");
    setDriverId(defaultDriverId);
  }

  async function submit() {
    if (!subject.trim()) {
      toast.error("Subject required");
      return;
    }
    if (!driverId) {
      toast.error("Pick a driver");
      return;
    }
    setBusy(true);
    try {
      const conv = await api.openConversation({
        topic,
        topicRefId: null,
        subject: subject.trim(),
        counterpartyId: driverId,
      });
      toast.success("Conversation opened");
      onCreated(conv.id);
      onOpenChange(false);
      reset();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New conversation</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Driver</Label>
            <Select value={driverId} onValueChange={setDriverId}>
              <SelectTrigger data-testid="mechanic-new-conv-driver">
                <SelectValue placeholder="Pick a driver" />
              </SelectTrigger>
              <SelectContent>
                {drivers.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Topic</Label>
            <Select value={topic} onValueChange={(v) => setTopic(v as ConversationTopic)}>
              <SelectTrigger data-testid="mechanic-new-conv-topic">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="general">General</SelectItem>
                <SelectItem value="job">Job</SelectItem>
                <SelectItem value="vehicle">Vehicle</SelectItem>
                <SelectItem value="maintenance">Maintenance</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="mechanic-new-conv-subject">Subject</Label>
            <Input
              id="mechanic-new-conv-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="What's it about?"
              data-testid="mechanic-new-conv-subject"
            />
          </div>
          <Button
            onClick={() => void submit()}
            disabled={busy}
            data-testid="mechanic-submit-new-conversation"
            className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
          >
            {busy ? "Opening…" : "Open conversation"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.floor(hr / 24);
  return `${d}d`;
}
