// Generic renderer for admin-built form templates (JSAs, site visits,
// custom forms). One page draws ANY template from /admin/form-templates:
// typed fields, required-field enforcement, photo uploads to the private
// form-photos bucket, GPS + timestamp stamped automatically.
//
// Online-only by design for v1: photo uploads don't fit the offline queue's
// localStorage budget. The dump/load + daily forms (the safety-critical
// offline paths) remain queue-backed.

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { DriverShell } from "@/components/layout/DriverLayout";
import { useAuth } from "@/contexts/AuthContext";
import { api, type FormTemplate, type FormTemplateField } from "@/lib/api";
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
import { ArrowLeft, Loader2, FileText, Camera, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { GpsBadge, useGpsCapture } from "@/components/crm/GpsBadge";

export const Route = createFileRoute("/driver/custom-form/$templateId")({
  head: () => ({ meta: [{ title: "Form — Yardward Pro" }] }),
  component: Page,
});

function Page() {
  const { templateId } = Route.useParams();
  const nav = useNavigate();
  const { user } = useAuth();
  const gps = useGpsCapture(null);
  const [template, setTemplate] = useState<FormTemplate | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});

  useEffect(() => {
    void (async () => {
      try {
        const all = await api.fetchFormTemplates();
        const t = all.find((x) => x.id === templateId);
        if (t) setTemplate(t);
        else setNotFound(true);
      } catch {
        setNotFound(true);
      }
    })();
  }, [templateId]);

  function setVal(key: string, v: string) {
    setValues((x) => ({ ...x, [key]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!template) return;
    const bad: Record<string, string> = {};
    for (const f of template.fields) {
      if (!f.required) continue;
      if (f.type === "photos") {
        if (photoFiles.length === 0) bad[f.key] = "Add at least one photo";
      } else if (!(values[f.key] ?? "").trim()) {
        bad[f.key] = "Required";
      }
    }
    setErrs(bad);
    if (Object.keys(bad).length) return;
    setSubmitting(true);
    try {
      const paths: string[] = [];
      for (const file of photoFiles) {
        const up = await api.uploadFormPhoto(file);
        if (!up.ok) {
          toast.error(`Photo upload failed: ${up.reason}`);
          return;
        }
        paths.push(up.path);
      }
      const gpsCoords = gps.result?.ok ? gps.result.coords : null;
      const r = await api.submitCustomForm({
        template,
        data: values,
        photos: paths,
        submittedBy: user.id,
        submittedName: user.name,
        gpsLat: gpsCoords?.lat ?? null,
        gpsLng: gpsCoords?.lng ?? null,
      });
      if (!r.ok) {
        toast.error(r.reason);
        return;
      }
      toast.success(`${template.name} submitted`);
      nav({ to: "/driver/forms" });
    } finally {
      setSubmitting(false);
    }
  }

  if (notFound) {
    return (
      <DriverShell>
        <div className="p-4">
          <Link
            to="/driver/forms"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground mb-3"
          >
            <ArrowLeft className="w-4 h-4" /> Back
          </Link>
          <p className="text-sm text-muted-foreground py-8 text-center">
            This form is no longer available — ask the office.
          </p>
        </div>
      </DriverShell>
    );
  }

  if (!template) {
    return (
      <DriverShell>
        <div className="p-4 py-16 text-center">
          <Loader2 className="w-6 h-6 animate-spin inline text-muted-foreground" />
        </div>
      </DriverShell>
    );
  }

  return (
    <DriverShell>
      <div className="p-4">
        <Link
          to="/driver/forms"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground mb-3"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>
        <div className="flex items-start justify-between gap-2">
          <h1 className="text-xl font-bold flex items-center gap-2">
            <FileText className="w-5 h-5" /> {template.name}
          </h1>
          <GpsBadge result={gps.result} loading={gps.loading} onRetry={gps.refresh} />
        </div>

        <form onSubmit={submit} className="mt-5 space-y-4">
          {template.fields.map((f) => (
            <FieldInput
              key={f.key}
              field={f}
              value={values[f.key] ?? ""}
              error={errs[f.key]}
              onChange={(v) => setVal(f.key, v)}
              photoFiles={photoFiles}
              setPhotoFiles={setPhotoFiles}
            />
          ))}
          <Button
            type="submit"
            disabled={submitting}
            className="w-full h-14 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 font-bold"
            data-testid="custom-form-submit"
          >
            {submitting ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" /> Submitting…
              </>
            ) : (
              `Submit ${template.name}`
            )}
          </Button>
        </form>
      </div>
    </DriverShell>
  );
}

function FieldInput({
  field: f,
  value,
  error,
  onChange,
  photoFiles,
  setPhotoFiles,
}: {
  field: FormTemplateField;
  value: string;
  error?: string;
  onChange: (v: string) => void;
  photoFiles: File[];
  setPhotoFiles: React.Dispatch<React.SetStateAction<File[]>>;
}) {
  if (f.type === "photos") {
    return (
      <div>
        <Label>
          {f.label}
          {f.required ? " *" : ""}
        </Label>
        <label
          className={cn(
            "mt-1.5 flex items-center justify-center gap-2 h-14 border-2 border-dashed rounded-md cursor-pointer text-sm text-muted-foreground hover:border-amber-brand",
            error && "border-danger",
          )}
        >
          <Camera className="w-5 h-5" /> Add photos
          <input
            type="file"
            accept="image/*"
            multiple
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              setPhotoFiles((arr) => [...arr, ...files].slice(0, 10));
              e.target.value = "";
            }}
            data-testid="custom-form-photos"
          />
        </label>
        {photoFiles.length > 0 && (
          <div className="grid grid-cols-3 gap-2 mt-2">
            {photoFiles.map((file, i) => (
              <div key={`${file.name}-${i}`} className="relative">
                <img
                  src={URL.createObjectURL(file)}
                  alt={file.name}
                  className="rounded-md border border-border w-full h-20 object-cover"
                />
                <button
                  type="button"
                  onClick={() => setPhotoFiles((arr) => arr.filter((_, idx) => idx !== i))}
                  className="absolute -top-1.5 -right-1.5 bg-danger text-white rounded-full p-0.5"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {error && <p className="text-xs text-danger mt-1">{error}</p>}
      </div>
    );
  }

  return (
    <div>
      <Label>
        {f.label}
        {f.required ? " *" : ""}
      </Label>
      {f.type === "textarea" ? (
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          className={cn("mt-1.5", error && "border-danger")}
          data-testid={`custom-form-${f.key}`}
        />
      ) : f.type === "select" ? (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger
            className={cn("h-12 mt-1.5", error && "border-danger")}
            data-testid={`custom-form-${f.key}`}
          >
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            {(f.options ?? []).filter(Boolean).map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : f.type === "checkbox" ? (
        <label className="flex items-center gap-2 mt-2 text-sm">
          <input
            type="checkbox"
            checked={value === "yes"}
            onChange={(e) => onChange(e.target.checked ? "yes" : "")}
            data-testid={`custom-form-${f.key}`}
          />
          Yes
        </label>
      ) : (
        <Input
          type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cn("h-12 mt-1.5", error && "border-danger")}
          data-testid={`custom-form-${f.key}`}
        />
      )}
      {error && <p className="text-xs text-danger mt-1">{error}</p>}
    </div>
  );
}
