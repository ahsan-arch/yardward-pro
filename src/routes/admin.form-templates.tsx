// Self-serve form builder (Phase 4 of the Formstack replacement).
//
// John creates and edits form templates here — per-client JSAs, site-visit
// checklists, blank one-off forms — without calling the developers. Each
// template is a list of typed fields; the driver app renders any template
// with one generic page (/driver/custom-form/<id>). The Submissions tab is
// the searchable history ("what did we note at that plant in March?") with
// photo viewing via signed URLs.

import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import {
  api,
  type FormTemplate,
  type FormTemplateField,
  type CustomFormSubmission,
} from "@/lib/api";
import { useData } from "@/contexts/DataContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Plus, Trash2, Search, Pencil, Image as ImageIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/form-templates")({
  head: () => ({ meta: [{ title: "Form templates — Engage Hydrovac CRM" }] }),
  component: Page,
});

const FIELD_TYPES: FormTemplateField["type"][] = [
  "text",
  "textarea",
  "number",
  "date",
  "select",
  "checkbox",
  "photos",
];

const NONE_CLIENT = "__all__";

function Page() {
  const [tab, setTab] = useState<"templates" | "submissions">("templates");
  return (
    <AdminShell title="Form templates">
      <div className="space-y-4">
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            <TabsTrigger value="templates" data-testid="ft-tab-templates">
              Templates
            </TabsTrigger>
            <TabsTrigger value="submissions" data-testid="ft-tab-submissions">
              Submissions
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {tab === "templates" ? <TemplatesTab /> : <SubmissionsTab />}
      </div>
    </AdminShell>
  );
}

// ---------------------------------------------------------------------------
// Templates tab — list + editor dialog
// ---------------------------------------------------------------------------

function TemplatesTab() {
  const { clients } = useData();
  const [templates, setTemplates] = useState<FormTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<FormTemplate | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTemplates(await api.fetchFormTemplates({ includeInactive: true }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load templates");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  function newTemplate() {
    setEditing({
      id: "",
      name: "",
      kind: "custom",
      clientId: null,
      fields: [{ key: "field_1", label: "", type: "text", required: true }],
      active: true,
      sort: templates.length + 1,
    });
  }

  return (
    <>
      <div className="flex justify-between items-center">
        <p className="text-sm text-muted-foreground">
          Drivers see active templates under Forms → Site & safety forms. Edit anything here —
          changes are live immediately, no developer needed.
        </p>
        <Button
          onClick={newTemplate}
          className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 shrink-0"
          data-testid="ft-new"
        >
          <Plus className="w-4 h-4" /> New template
        </Button>
      </div>

      {loading ? (
        <div className="py-10 text-center">
          <Loader2 className="w-5 h-5 animate-spin inline text-muted-foreground" />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {templates.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setEditing(t)}
              className="text-left bg-card border border-border rounded-lg p-4 hover:border-amber-brand transition-colors"
              data-testid={`ft-card-${t.id}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold truncate">{t.name}</span>
                <Pencil className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {t.kind} · {t.fields.length} fields
                {t.clientId
                  ? ` · ${clients.find((c) => c.id === t.clientId)?.name ?? t.clientId}`
                  : " · all clients"}
                {!t.active && " · INACTIVE"}
              </div>
            </button>
          ))}
          {templates.length === 0 && (
            <p className="text-sm text-muted-foreground col-span-full py-6 text-center">
              No templates yet — create one.
            </p>
          )}
        </div>
      )}

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing?.id ? `Edit: ${editing.name}` : "New template"}</DialogTitle>
          </DialogHeader>
          {editing && (
            <TemplateEditor
              template={editing}
              clients={clients.map((c) => ({ id: c.id, name: c.name }))}
              onSaved={() => {
                setEditing(null);
                void load();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function TemplateEditor({
  template,
  clients,
  onSaved,
}: {
  template: FormTemplate;
  clients: Array<{ id: string; name: string }>;
  onSaved: () => void;
}) {
  const [t, setT] = useState<FormTemplate>(template);
  const [saving, setSaving] = useState(false);

  function patchField(i: number, p: Partial<FormTemplateField>) {
    setT((x) => ({
      ...x,
      fields: x.fields.map((f, idx) => (idx === i ? { ...f, ...p } : f)),
    }));
  }
  function addField() {
    setT((x) => ({
      ...x,
      fields: [
        ...x.fields,
        { key: `field_${x.fields.length + 1}`, label: "", type: "text", required: false },
      ],
    }));
  }
  function removeField(i: number) {
    setT((x) => ({ ...x, fields: x.fields.filter((_, idx) => idx !== i) }));
  }

  async function save() {
    if (!t.name.trim()) {
      toast.error("Template needs a name");
      return;
    }
    const bad = t.fields.find((f) => !f.label.trim());
    if (bad) {
      toast.error("Every field needs a label");
      return;
    }
    setSaving(true);
    try {
      // Keys are derived from labels (stable, unique) so submissions store
      // readable data; existing keys are preserved on edit.
      const seen = new Set<string>();
      const fields = t.fields.map((f, i) => {
        let key =
          f.key?.trim() ||
          f.label
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .slice(0, 40);
        if (!key || seen.has(key)) key = `${key || "field"}_${i + 1}`;
        seen.add(key);
        return { ...f, key };
      });
      const r = await api.saveFormTemplate({ ...t, fields, id: t.id || undefined });
      if (!r.ok) {
        toast.error(r.reason);
        return;
      }
      toast.success(`Template saved${t.active ? " — live for drivers now" : ""}`);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Name</Label>
          <Input
            value={t.name}
            onChange={(e) => setT({ ...t, name: e.target.value })}
            placeholder="e.g. Hydro One JSA"
            className="mt-1"
            data-testid="ft-name"
          />
        </div>
        <div>
          <Label>Kind</Label>
          <Select
            value={t.kind}
            onValueChange={(v) => setT({ ...t, kind: v as FormTemplate["kind"] })}
          >
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="jsa">JSA</SelectItem>
              <SelectItem value="site-visit">Site visit</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Client (optional — for client-specific variants)</Label>
          <Select
            value={t.clientId ?? NONE_CLIENT}
            onValueChange={(v) => setT({ ...t, clientId: v === NONE_CLIENT ? null : v })}
          >
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_CLIENT}>All clients</SelectItem>
              {clients.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end gap-2 pb-1">
          <Switch
            id="ft-active"
            checked={t.active}
            onCheckedChange={(v) => setT({ ...t, active: v })}
          />
          <Label htmlFor="ft-active" className="cursor-pointer">
            Active (visible to drivers)
          </Label>
        </div>
      </div>

      <div className="space-y-2">
        <Label>Fields</Label>
        {t.fields.map((f, i) => (
          <div
            key={i}
            className="flex flex-wrap items-center gap-2 border border-border rounded-md p-2"
          >
            <Input
              value={f.label}
              onChange={(e) => patchField(i, { label: e.target.value })}
              placeholder="Field label"
              className="flex-1 min-w-40 h-9"
              data-testid={`ft-field-label-${i}`}
            />
            <Select
              value={f.type}
              onValueChange={(v) => patchField(i, { type: v as FormTemplateField["type"] })}
            >
              <SelectTrigger className="w-28 h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FIELD_TYPES.map((ty) => (
                  <SelectItem key={ty} value={ty}>
                    {ty}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {f.type === "select" && (
              <Input
                value={(f.options ?? []).join(", ")}
                onChange={(e) =>
                  patchField(i, {
                    options: e.target.value.split(",").map((s) => s.trim()),
                  })
                }
                placeholder="Options, comma, separated"
                className="flex-1 min-w-40 h-9"
              />
            )}
            <label className="flex items-center gap-1.5 text-xs whitespace-nowrap">
              <input
                type="checkbox"
                checked={f.required}
                onChange={(e) => patchField(i, { required: e.target.checked })}
              />
              required
            </label>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-danger hover:text-danger"
              onClick={() => removeField(i)}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={addField} data-testid="ft-add-field">
          <Plus className="w-4 h-4" /> Add field
        </Button>
      </div>

      <Button
        onClick={() => void save()}
        disabled={saving}
        className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
        data-testid="ft-save"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save template"}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Submissions tab — searchable history with photos
// ---------------------------------------------------------------------------

function SubmissionsTab() {
  const [rows, setRows] = useState<CustomFormSubmission[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [templates, setTemplates] = useState<FormTemplate[]>([]);
  const [templateId, setTemplateId] = useState<string>("__all__");
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<CustomFormSubmission | null>(null);
  const PAGE = 50;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, tpls] = await Promise.all([
        api.fetchCustomFormSubmissions({
          templateId: templateId === "__all__" ? undefined : templateId,
          search: search || undefined,
          limit: PAGE,
          offset: page * PAGE,
        }),
        api.fetchFormTemplates({ includeInactive: true }),
      ]);
      setRows(list.rows);
      setTotal(list.total);
      setTemplates(tpls);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load submissions");
    } finally {
      setLoading(false);
    }
  }, [templateId, search, page]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-48">
          <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-muted-foreground" />
          <Input
            placeholder="Search form / submitter…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            className="pl-8"
          />
        </div>
        <Select
          value={templateId}
          onValueChange={(v) => {
            setTemplateId(v);
            setPage(0);
          }}
        >
          <SelectTrigger className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All templates</SelectItem>
            {templates.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Submitted</th>
              <th className="px-3 py-2 font-medium">Form</th>
              <th className="px-3 py-2 font-medium">By</th>
              <th className="px-3 py-2 font-medium">Photos</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
                  <Loader2 className="w-5 h-5 animate-spin inline" />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
                  No submissions yet.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-t border-border hover:bg-muted/30 cursor-pointer"
                  onClick={() => setOpen(r)}
                >
                  <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">
                    {new Date(r.loggedAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">{r.templateName}</td>
                  <td className="px-3 py-2">{r.submittedName}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {r.photos.length > 0 ? (
                      <span className="inline-flex items-center gap-1 text-xs">
                        <ImageIcon className="w-3.5 h-3.5" /> {r.photos.length}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{total} submissions</span>
        <div className="flex gap-2 items-center">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            Prev
          </Button>
          <span>
            Page {page + 1} / {Math.max(1, Math.ceil(total / PAGE))}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={(page + 1) * PAGE >= total}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </div>

      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent className="overflow-y-auto sm:max-w-xl">
          {open && <SubmissionDetail row={open} />}
        </SheetContent>
      </Sheet>
    </>
  );
}

function SubmissionDetail({ row }: { row: CustomFormSubmission }) {
  const [photoUrls, setPhotoUrls] = useState<string[]>([]);
  useEffect(() => {
    void (async () => {
      const urls = await Promise.all(row.photos.map((p) => api.getFormPhotoUrl(p)));
      setPhotoUrls(urls.filter((u): u is string => !!u));
    })();
  }, [row]);

  return (
    <>
      <SheetHeader>
        <SheetTitle>
          {row.templateName}
          <span className="block text-xs font-normal text-muted-foreground mt-1">
            {row.submittedName} · {new Date(row.loggedAt).toLocaleString()}
            {row.gpsLat != null && row.gpsLng != null && (
              <>
                {" · "}
                <a
                  href={`https://maps.google.com/?q=${row.gpsLat},${row.gpsLng}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-amber-brand hover:underline"
                >
                  map
                </a>
              </>
            )}
          </span>
        </SheetTitle>
      </SheetHeader>
      <div className="mt-4 space-y-3">
        {Object.entries(row.data).map(([k, v]) => {
          const val = (v ?? "").toString().trim();
          if (!val) return null;
          return (
            <div key={k} className="border-b border-border pb-2">
              <div className="text-xs text-muted-foreground">{k.replaceAll("_", " ")}</div>
              <div className="text-sm whitespace-pre-wrap">{val}</div>
            </div>
          );
        })}
        {photoUrls.length > 0 && (
          <div className="grid grid-cols-2 gap-2 pt-2">
            {photoUrls.map((u) => (
              <a key={u} href={u} target="_blank" rel="noreferrer">
                <img src={u} alt="submission" className="rounded-md border border-border w-full" />
              </a>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
