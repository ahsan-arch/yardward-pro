-- =============================================================================
-- Form template engine (Phase 4 of the Formstack replacement).
--
-- The customer's #1 structural ask: John must be able to create and edit
-- forms HIMSELF (per-client JSAs, site-visit checklists, blank/custom forms)
-- without a code change. A template is a jsonb array of field definitions:
--   [{ key, label, type, required, options? }]
--   type ∈ text | textarea | number | date | select | checkbox | photos
-- One generic renderer in the driver app draws any template; submissions are
-- stored as { fieldKey: value } jsonb plus uploaded photo paths.
--
--   - form_templates: the definitions. client_id null = available to all;
--     set = client-specific variant (Halton JSA vs Hydro One JSA).
--   - form_submissions: filled-out instances with GPS + photos. Searchable
--     history ("what did we note at this plant in March?").
--   - storage bucket form-photos: private; same policy shape as
--     ticket-photos. Admin views via signed URLs.
-- =============================================================================

create table if not exists public.form_templates (
  id         text primary key,
  name       text not null,
  kind       text not null default 'custom' check (kind in ('jsa', 'site-visit', 'custom')),
  client_id  text references public.clients (id) on delete set null,
  fields     jsonb not null default '[]'::jsonb,
  active     boolean not null default true,
  sort       integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.form_templates enable row level security;

create policy form_templates_admin_all on public.form_templates
  for all using (is_admin()) with check (is_admin());

-- Drivers/mechanics need to read active templates to render them.
create policy form_templates_authenticated_read on public.form_templates
  for select to authenticated using (active = true);

create table if not exists public.form_submissions (
  id              text primary key,
  template_id     text references public.form_templates (id) on delete set null,
  template_name   text not null default '',
  template_kind   text not null default 'custom',
  client_id       text references public.clients (id) on delete set null,
  submitted_by    uuid references public.profiles (id) on delete set null,
  submitted_name  text not null default '',
  data            jsonb not null default '{}'::jsonb,
  photos          text[] not null default '{}',
  gps_lat         double precision,
  gps_lng         double precision,
  logged_at       timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index if not exists form_submissions_template_idx
  on public.form_submissions (template_id, logged_at desc);
create index if not exists form_submissions_logged_idx
  on public.form_submissions (logged_at desc);

alter table public.form_submissions enable row level security;

create policy form_submissions_admin_all on public.form_submissions
  for all using (is_admin()) with check (is_admin());

create policy form_submissions_own_read on public.form_submissions
  for select using (submitted_by = auth.uid());

create policy form_submissions_own_insert on public.form_submissions
  for insert with check (submitted_by = auth.uid());

-- ---- Photo storage ----------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'form-photos',
  'form-photos',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

create policy "form_photos_admin_all" on storage.objects
  for all
  using (bucket_id = 'form-photos' and is_admin())
  with check (bucket_id = 'form-photos' and is_admin());

create policy "form_photos_auth_insert" on storage.objects
  for insert
  with check (
    bucket_id = 'form-photos'
    and auth.role() = 'authenticated'
    and owner = auth.uid()
  );

create policy "form_photos_auth_select_own" on storage.objects
  for select
  using (bucket_id = 'form-photos' and owner = auth.uid());

-- ---- Seed templates (editable/deletable by John afterwards) ------------------
insert into public.form_templates (id, name, kind, fields, sort) values
(
  'FT-SITE-VISIT',
  'Pre-work site visit',
  'site-visit',
  '[
    {"key":"site_name","label":"Plant / site name","type":"text","required":true},
    {"key":"work_location","label":"Location of the work","type":"textarea","required":true},
    {"key":"confined_space","label":"Confined space requirements?","type":"select","required":true,"options":["No","Yes"]},
    {"key":"equipment","label":"Equipment required","type":"textarea","required":false},
    {"key":"staffing","label":"Staff requirements","type":"text","required":false},
    {"key":"hazards","label":"Hazards identified","type":"textarea","required":true},
    {"key":"notes","label":"Notes","type":"textarea","required":false},
    {"key":"photos","label":"Site photos","type":"photos","required":false}
  ]'::jsonb,
  1
),
(
  'FT-JSA-GENERIC',
  'JSA — Generic',
  'jsa',
  '[
    {"key":"task","label":"Task description","type":"text","required":true},
    {"key":"hazards","label":"Hazards (two minimum)","type":"textarea","required":true},
    {"key":"controls","label":"Controls / mitigation","type":"textarea","required":true},
    {"key":"ppe","label":"PPE required","type":"text","required":true},
    {"key":"unique_conditions","label":"Unique site conditions","type":"textarea","required":false}
  ]'::jsonb,
  2
),
(
  'FT-BLANK',
  'Blank form',
  'custom',
  '[
    {"key":"title","label":"Title","type":"text","required":true},
    {"key":"body","label":"Details","type":"textarea","required":true},
    {"key":"photos","label":"Photos","type":"photos","required":false}
  ]'::jsonb,
  3
)
on conflict (id) do nothing;
