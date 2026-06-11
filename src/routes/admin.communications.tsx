// /admin/communications — split-view inbox where admins see every driver↔
// mechanic thread in the org (via RLS observe-by-role). Default filter is
// "Tagged me" so admins aren't overwhelmed by the full firehose; they can
// switch to "Joined" or "All". Admins can self-join any observed thread to
// reply (handled inside ConversationView's compose vs. Join button switch).
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AdminShell } from "@/components/layout/AdminLayout";
import { useAuth } from "@/contexts/AuthContext";
import { useData } from "@/contexts/DataContext";
import { ConversationView } from "@/components/crm/ConversationView";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Search, MessageSquare, Plus } from "lucide-react";
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

export const Route = createFileRoute("/admin/communications")({
  beforeLoad: () => {
    if (typeof window === "undefined") return;
    if (localStorage.getItem("fo:authed") !== "1") {
      throw redirect({ to: "/login" });
    }
    const role = localStorage.getItem("fo:role");
    if (role !== "admin") throw redirect({ to: homeForRole(role) });
  },
  head: () => ({ meta: [{ title: "Communications — Engage Hydrovac CRM" }] }),
  component: Page,
});

type FilterChip = "tagged" | "joined" | "all";

function Page() {
  const { user } = useAuth();
  const {
    conversations,
    conversationParticipants,
    messages,
    drivers,
    mechanics,
  } = useData();

  const [filter, setFilter] = useState<FilterChip>("tagged");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  // Resolve which threads the admin actively participates in.
  const myActiveConvIds = useMemo(
    () =>
      new Set(
        conversationParticipants
          .filter((p) => p.userId === user.id && p.leftAt === null)
          .map((p) => p.conversationId),
      ),
    [conversationParticipants, user.id],
  );

  const filteredConvs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return conversations
      .filter((c) => {
        if (filter === "tagged" || filter === "joined") {
          if (!myActiveConvIds.has(c.id)) return false;
        }
        if (q && !c.subject.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort(
        (a, b) =>
          new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime(),
      );
  }, [conversations, filter, search, myActiveConvIds]);

  // Auto-select first conversation when none is picked or selection drops out
  // of the filtered set.
  useEffect(() => {
    if (selectedId && filteredConvs.some((c) => c.id === selectedId)) return;
    if (filteredConvs.length > 0) setSelectedId(filteredConvs[0].id);
    else setSelectedId(null);
  }, [filteredConvs, selectedId]);

  const selectedConv = selectedId
    ? conversations.find((c) => c.id === selectedId) ?? null
    : null;
  const selectedParticipants = selectedId
    ? conversationParticipants.filter((p) => p.conversationId === selectedId)
    : [];
  const selectedMessages = selectedId
    ? messages
        .filter((m) => m.conversationId === selectedId)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    : [];

  // Per-conversation badges: unread + tagged-state.
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

  function participantSummary(convId: string): string {
    const cps = conversationParticipants.filter(
      (p) => p.conversationId === convId && p.leftAt === null,
    );
    const names = cps.slice(0, 3).map((p) => {
      const d = drivers.find((x) => x.id === p.userId);
      if (d) return d.name.split(" ")[0];
      const m = mechanics.find((x) => x.id === p.userId);
      if (m) return m.name.split(" ")[0];
      return p.userId.slice(0, 4);
    });
    return names.join(", ") + (cps.length > 3 ? ` +${cps.length - 3}` : "");
  }

  return (
    <AdminShell title="Communications">
      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-4 h-[calc(100vh-140px)]">
        {/* Left rail: filters + list */}
        <aside className="flex flex-col border border-border rounded-lg overflow-hidden bg-card">
          <div className="p-3 border-b border-border space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex gap-1">
                {(["tagged", "joined", "all"] as FilterChip[]).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    data-testid={`filter-${f}`}
                    className={cn(
                      "text-xs px-2 py-1 rounded font-medium",
                      filter === f
                        ? "bg-amber-brand text-amber-brand-foreground"
                        : "text-muted-foreground hover:bg-muted",
                    )}
                  >
                    {f === "tagged" ? "Tagged me" : f === "joined" ? "Joined" : "All"}
                  </button>
                ))}
              </div>
              <Button
                size="sm"
                onClick={() => setNewOpen(true)}
                data-testid="open-new-conversation"
                className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 h-8"
              >
                <Plus className="w-4 h-4" /> New
              </Button>
            </div>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search subject…"
                className="h-8 pl-7 text-sm"
                data-testid="conv-search"
              />
            </div>
          </div>
          <div
            className="flex-1 overflow-y-auto"
            data-testid="conversation-list"
          >
            {filteredConvs.length === 0 && (
              <div className="p-6 text-center text-sm text-muted-foreground">
                <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-40" />
                {filter === "tagged"
                  ? "Nothing tagged yet."
                  : filter === "joined"
                    ? "You haven't joined any conversations."
                    : "No conversations yet."}
              </div>
            )}
            {filteredConvs.map((c) => {
              const unread = unreadCount(c.id);
              const isSelected = c.id === selectedId;
              return (
                <button
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  data-testid="conv-row"
                  data-conv-id={c.id}
                  className={cn(
                    "w-full text-left p-3 border-b border-border/50 hover:bg-muted/50",
                    isSelected && "bg-amber-brand/5 border-l-2 border-l-amber-brand",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold truncate">{c.subject}</p>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">
                        {participantSummary(c.id)}
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
                  <div className="flex items-center gap-1 mt-1">
                    <span className="text-[10px] capitalize text-muted-foreground">
                      {c.topic}
                    </span>
                    {c.status !== "active" && (
                      <span className="text-[10px] text-muted-foreground">
                        · {c.status}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Right pane: ConversationView keyed on id so switching threads
            fully remounts (clears compose draft + scroll). Realtime updates
            to the same thread re-render in place. */}
        <main className="border border-border rounded-lg overflow-hidden bg-card">
          {selectedConv ? (
            <ConversationView
              key={selectedConv.id}
              conversation={selectedConv}
              messages={selectedMessages}
              participants={selectedParticipants}
              viewerRole="admin"
            />
          ) : (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
              Select a conversation to start.
            </div>
          )}
        </main>
      </div>

      <NewConversationDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreated={(id) => {
          setSelectedId(id);
          setFilter("joined");
        }}
      />
    </AdminShell>
  );
}

function NewConversationDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (conversationId: string) => void;
}) {
  const { drivers, mechanics } = useData();
  const [topic, setTopic] = useState<ConversationTopic>("general");
  const [subject, setSubject] = useState("");
  const [participantIds, setParticipantIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  function reset() {
    setTopic("general");
    setSubject("");
    setParticipantIds([]);
  }

  async function submit() {
    if (!subject.trim()) {
      toast.error("Subject is required");
      return;
    }
    if (participantIds.length === 0) {
      toast.error("Add at least one participant");
      return;
    }
    setBusy(true);
    try {
      const conv = await api.openConversationWithParticipants({
        topic,
        topicRefId: null,
        subject: subject.trim(),
        participantIds,
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

  function toggle(id: string) {
    setParticipantIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
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
            <Label>Topic</Label>
            <Select
              value={topic}
              onValueChange={(v) => setTopic(v as ConversationTopic)}
            >
              <SelectTrigger data-testid="new-conv-topic">
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
            <Label htmlFor="new-conv-subject">Subject</Label>
            <Input
              id="new-conv-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="What's it about?"
              data-testid="new-conv-subject"
            />
          </div>
          <div>
            <Label>Participants (driver + mechanic)</Label>
            <div className="max-h-40 overflow-y-auto border border-border rounded-md p-2 space-y-1 mt-1">
              {[
                ...drivers.map((d) => ({ id: d.id, name: d.name, role: "driver" })),
                ...mechanics.map((m) => ({ id: m.id, name: m.name, role: "mechanic" })),
              ].map((p) => (
                <label
                  key={p.id}
                  className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/40 rounded px-1 py-0.5"
                  data-testid="participant-option"
                  data-user-id={p.id}
                >
                  <input
                    type="checkbox"
                    checked={participantIds.includes(p.id)}
                    onChange={() => toggle(p.id)}
                  />
                  <span className="flex-1">{p.name}</span>
                  <span className="text-xs text-muted-foreground capitalize">{p.role}</span>
                </label>
              ))}
            </div>
          </div>
          <Button
            onClick={() => void submit()}
            disabled={busy}
            data-testid="submit-new-conversation"
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
