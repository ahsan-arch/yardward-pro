// ConversationView — shared message-pane used by /admin/communications,
// /driver/messages, /mechanic/messages. Compose box adapts to the viewer's
// role: drivers + mechanics get the @-tag-admin affordance; admins viewing a
// thread they haven't joined see a "Join conversation" button instead of the
// textarea (per the strict observe-by-role topology — they can read, but
// can't post until they join). Realtime updates flow in via DataContext; this
// component is keyed on conversationId by the parent so a switch to a
// different thread fully remounts (clears draft / scroll position) while
// realtime updates to the SAME thread just re-render.
import { useEffect, useMemo, useRef, useState } from "react";
import { Send, Paperclip, AtSign, X, Lock, CheckCircle2, Loader2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useData } from "@/contexts/DataContext";
import type { Conversation, ConversationParticipant, Message } from "@/types/domain";

export interface ConversationViewProps {
  conversation: Conversation;
  messages: Message[]; // already filtered + sorted ASC by parent
  participants: ConversationParticipant[]; // for this conversation
  /** Role the current viewer plays in the app shell. */
  viewerRole: "admin" | "driver" | "mechanic";
}

export function ConversationView({
  conversation,
  messages,
  participants,
  viewerRole,
}: ConversationViewProps) {
  const { user } = useAuth();
  const { drivers, mechanics } = useData();
  const viewerId = user.id;
  const isParticipant = participants.some((p) => p.userId === viewerId && p.leftAt === null);
  const isOriginator = conversation.createdBy === viewerId;
  const canClose = conversation.status === "active" && (viewerRole === "admin" || isOriginator);
  const isClosed = conversation.status === "closed";

  const activeAdmins = useMemo(
    () => participants.filter((p) => p.participantRole === "admin" && p.leftAt === null),
    [participants],
  );

  // Compose state
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [joining, setJoining] = useState(false);
  const [tagging, setTagging] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeReason, setCloseReason] = useState("");
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  // Pending attachments. Each entry is { path, name } — already uploaded.
  const [pendingAttachments, setPendingAttachments] = useState<{ path: string; name: string }[]>(
    [],
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Signed-URL cache for inline attachment rendering. Keyed by storage path.
  const [signedUrls, setSignedUrls] = useState<Record<string, string | null>>({});

  useEffect(() => {
    // Mint signed URLs for every media_paths entry across visible messages.
    // Re-signs every 30 minutes to stay well inside the 1h TTL.
    let cancelled = false;
    async function refresh() {
      const paths = new Set<string>();
      for (const m of messages) {
        for (const p of m.mediaPaths) paths.add(p);
      }
      const next: Record<string, string | null> = {};
      await Promise.all(
        Array.from(paths).map(async (p) => {
          if (signedUrls[p]) {
            next[p] = signedUrls[p];
            return;
          }
          const url = await api.signMessageAttachment(p);
          next[p] = url;
        }),
      );
      if (!cancelled) setSignedUrls((prev) => ({ ...prev, ...next }));
    }
    void refresh();
    const id = window.setInterval(() => void refresh(), 30 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // signedUrls intentionally not in deps — would loop. eslint quieted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // Auto-scroll to bottom on new message arrival.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // Mark read when this view mounts (and again when new messages arrive after mount).
  useEffect(() => {
    void api.markConversationRead(conversation.id).catch(() => {});
  }, [conversation.id, messages.length]);

  async function handleAttach(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      toast.error("Attachment must be 10MB or smaller");
      return;
    }
    try {
      const path = await api.uploadMessageAttachment({
        conversationId: conversation.id,
        file,
        fileName: file.name,
      });
      setPendingAttachments((prev) => [...prev, { path, name: file.name }]);
      toast.success(`Attached ${file.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleSend() {
    if (isClosed) {
      toast.error("Conversation is closed");
      return;
    }
    if (!draft.trim() && pendingAttachments.length === 0) {
      toast.error("Message or attachment required");
      return;
    }
    setSending(true);
    try {
      // Generate idempotency key so an offline-queue replay can't double-post.
      const idempotencyKey = `${conversation.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await api.sendMessage({
        conversationId: conversation.id,
        body: draft.trim(),
        mediaPaths: pendingAttachments.map((a) => a.path),
        idempotencyKey,
      });
      setDraft("");
      setPendingAttachments([]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  async function handleTagAdmins() {
    if (tagging) return;
    setTagging(true);
    try {
      const cps = await api.tagAdmins({ conversationId: conversation.id });
      if (cps.length === 0) {
        toast.info("All admins are already in this conversation");
      } else {
        toast.success(`Tagged ${cps.length} admin${cps.length === 1 ? "" : "s"}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Tag failed");
    } finally {
      setTagging(false);
    }
  }

  async function handleJoin() {
    setJoining(true);
    try {
      await api.joinConversation(conversation.id);
      toast.success("Joined conversation");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Join failed");
    } finally {
      setJoining(false);
    }
  }

  async function handleClose() {
    setClosing(true);
    try {
      await api.closeConversation(conversation.id, closeReason.trim());
      toast.success("Conversation closed");
      setShowCloseConfirm(false);
      setCloseReason("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Close failed");
    } finally {
      setClosing(false);
    }
  }

  // Resolve a participant's display name from drivers/mechanics rosters.
  function nameFor(userId: string): string {
    const d = drivers.find((x) => x.id === userId);
    if (d) return d.name;
    const m = mechanics.find((x) => x.id === userId);
    if (m) return m.name;
    return userId.slice(0, 8);
  }

  return (
    <div
      className="flex flex-col h-full"
      data-testid="conversation-view"
      data-conv-id={conversation.id}
    >
      {/* Header: subject + status + participant pills */}
      <div className="border-b border-border p-3 bg-card">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold truncate" data-testid="conv-subject">
              {conversation.subject}
            </h2>
            <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2">
              <span className="capitalize">{conversation.topic}</span>
              {conversation.topicRefId && <span>· {conversation.topicRefId}</span>}
              {isClosed && (
                <span className="inline-flex items-center gap-1 text-success">
                  <CheckCircle2 className="w-3 h-3" /> Closed
                </span>
              )}
            </div>
          </div>
          {canClose && !showCloseConfirm && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowCloseConfirm(true)}
              data-testid="open-close-conversation"
            >
              Close
            </Button>
          )}
        </div>
        {/* Participant pills */}
        <div className="flex flex-wrap gap-1.5 mt-2">
          {participants
            .filter((p) => p.leftAt === null)
            .map((p) => (
              <span
                key={p.id}
                className={cn(
                  "inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border font-mono",
                  p.participantRole === "admin"
                    ? "border-amber-brand/40 bg-amber-brand/10"
                    : p.participantRole === "mechanic"
                      ? "border-info/40 bg-info/10"
                      : "border-border bg-muted",
                )}
                data-testid="participant-pill"
                data-user-id={p.userId}
              >
                <span className="font-semibold">{nameFor(p.userId)}</span>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground">{p.participantRole}</span>
              </span>
            ))}
        </div>
      </div>

      {/* Close-confirm panel */}
      {showCloseConfirm && (
        <div className="border-b border-border p-3 bg-amber-brand/5">
          <p className="text-sm font-medium mb-2">Close this conversation?</p>
          <Textarea
            rows={2}
            placeholder="Resolution notes (optional)"
            value={closeReason}
            onChange={(e) => setCloseReason(e.target.value)}
            data-testid="close-reason"
          />
          <div className="flex gap-2 mt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setShowCloseConfirm(false);
                setCloseReason("");
              }}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleClose()}
              disabled={closing}
              data-testid="confirm-close-conversation"
              className="flex-1"
            >
              {closing ? "Closing…" : "Close"}
            </Button>
          </div>
        </div>
      )}

      {/* Message list */}
      <ScrollArea className="flex-1">
        <div ref={scrollRef} className="p-3 space-y-3" data-testid="message-list">
          {messages.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">
              No messages yet. Send the first one below.
            </p>
          )}
          {messages.map((m) => {
            const mine = m.senderId === viewerId;
            return (
              <div
                key={m.id}
                className={cn("flex flex-col gap-1", mine ? "items-end" : "items-start")}
                data-testid="message-row"
                data-message-id={m.id}
                data-sender-id={m.senderId}
              >
                <div className="text-[10px] text-muted-foreground font-mono">
                  {nameFor(m.senderId)} ·{" "}
                  {new Date(m.createdAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </div>
                <div
                  className={cn(
                    "max-w-[80%] rounded-2xl px-3 py-2 text-sm",
                    mine
                      ? "bg-amber-brand text-amber-brand-foreground rounded-br-sm"
                      : "bg-muted rounded-bl-sm",
                  )}
                >
                  {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
                  {m.mediaPaths.length > 0 && (
                    <div className="mt-2 flex flex-col gap-1.5">
                      {m.mediaPaths.map((p) => (
                        <a
                          key={p}
                          href={signedUrls[p] ?? "#"}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs underline truncate"
                          data-testid="message-attachment"
                        >
                          {signedUrls[p] ? (
                            isImagePath(p) ? (
                              <img
                                src={signedUrls[p] ?? ""}
                                alt="attachment"
                                className="max-w-full rounded"
                              />
                            ) : (
                              p.split("/").pop()
                            )
                          ) : (
                            <span className="inline-flex items-center gap-1">
                              <Loader2 className="w-3 h-3 animate-spin" /> Loading…
                            </span>
                          )}
                        </a>
                      ))}
                    </div>
                  )}
                  {/* Inbound MMS fallback: when media_paths is empty but
                      twilio_media_urls has entries, render those directly.
                      Twilio CDN URLs have a TTL, so this is best-effort —
                      the primary durable path is the webhook downloading +
                      uploading to message-attachments. If that fails (logged
                      to error_log), this fallback at least lets the recipient
                      see the photo while it's still fresh. */}
                  {m.mediaPaths.length === 0 && m.twilioMediaUrls.length > 0 && (
                    <div className="mt-2 flex flex-col gap-1.5">
                      {m.twilioMediaUrls.map((url, i) => {
                        // Defense-in-depth: twilioMediaUrls come from the
                        // HMAC-verified Twilio webhook (already trust-gated), but
                        // only ever render an http(s) URL as a clickable link /
                        // <img> — never a javascript:/data: URL.
                        const safe = /^https?:\/\//i.test(url);
                        return (
                          <a
                            key={`tmu-${i}`}
                            href={safe ? url : "#"}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs underline truncate"
                            data-testid="message-attachment-twilio"
                          >
                            {safe && isImageUrl(url) ? (
                              <img src={url} alt="attachment" className="max-w-full rounded" />
                            ) : (
                              (url.split("/").pop() ?? "attachment").slice(0, 64)
                            )}
                          </a>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Compose area OR Join button (admin observing) */}
      {isClosed ? (
        <div className="border-t border-border p-3 bg-muted/30 text-center text-sm text-muted-foreground">
          <Lock className="w-4 h-4 inline mr-1" /> This conversation is closed.
          {conversation.resolutionNotes && (
            <p className="mt-1 text-xs">Notes: {conversation.resolutionNotes}</p>
          )}
        </div>
      ) : !isParticipant ? (
        // Admin observing — show Join button.
        <div className="border-t border-border p-3 bg-muted/20 flex items-center gap-3">
          <p className="text-sm text-muted-foreground flex-1">
            You are observing this conversation. Join to reply.
          </p>
          <Button
            onClick={() => void handleJoin()}
            disabled={joining}
            data-testid="join-conversation"
            className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
          >
            {joining ? (
              "Joining…"
            ) : (
              <>
                <UserPlus className="w-4 h-4" /> Join conversation
              </>
            )}
          </Button>
        </div>
      ) : (
        <div className="border-t border-border p-3 bg-card">
          {/* Pending attachments */}
          {pendingAttachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {pendingAttachments.map((a) => (
                <span
                  key={a.path}
                  className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-muted border border-border"
                  data-testid="pending-attachment-chip"
                >
                  📎 {a.name}
                  <button
                    type="button"
                    onClick={() =>
                      setPendingAttachments((prev) => prev.filter((x) => x.path !== a.path))
                    }
                    aria-label={`Remove ${a.name}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type a message…"
              rows={2}
              className="flex-1 resize-none"
              data-testid="message-compose"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
            />
            <div className="flex flex-col gap-1.5">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                onChange={(e) => void handleAttach(e)}
                className="hidden"
                data-testid="attachment-input"
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Attach file"
                data-testid="open-attach"
                className="h-9 w-9"
              >
                <Paperclip className="w-4 h-4" />
              </Button>
              {/* Tag-admin: clicking immediately tags ALL active admins.
                  Per-admin selection is Phase 2 polish. Tagging is a no-op
                  for admins themselves (the picker would just tag the caller). */}
              {viewerRole !== "admin" && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void handleTagAdmins()}
                  disabled={tagging}
                  aria-label="Tag admin"
                  data-testid="tag-admin-button"
                  className="h-9 w-9"
                >
                  {tagging ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <AtSign className="w-4 h-4" />
                  )}
                </Button>
              )}
              <Button
                onClick={() => void handleSend()}
                disabled={sending}
                aria-label="Send"
                data-testid="send-message"
                className="h-9 w-9 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
              >
                {sending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function isImagePath(p: string): boolean {
  return /\.(jpe?g|png|webp|gif)$/i.test(p);
}

// Twilio CDN URLs typically don't have a file extension — the content type
// is what tells us it's an image. As a heuristic we also try MimeType=
// query params + path segments that hint at image content. Falling back to
// "render as image if it's a Twilio media URL" is reasonable: Twilio
// Conversations media is always image/audio/video/document and the bulk of
// MMS traffic is photos.
function isImageUrl(url: string): boolean {
  if (/\.(jpe?g|png|webp|gif|heic)([?#].*)?$/i.test(url)) return true;
  if (/image\/(jpe?g|png|webp|gif|heic)/i.test(url)) return true;
  // Twilio MCS URLs: render-as-image is the right default. The img tag will
  // gracefully degrade to a broken-image icon if the content is actually
  // audio/video/PDF — the underlying <a> link still opens cleanly.
  if (/twilio\.com\/.*Media/i.test(url)) return true;
  return false;
}
