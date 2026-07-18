-- =============================================================================
-- Work order photos.
--
-- Client feedback (Mechanic Profile #9): "Work Orders cannot be created and
-- how are the Work Orders going to be structured e.g. with service tasks and
-- inventory ability with photos etc. as this is crucial." Parts/inventory
-- attachment already exists (parts_used jsonb + BOM); this adds the missing
-- photo half — a mechanic can attach one or more photos to a work order
-- while it's in progress (damage evidence, before/after shots).
--
-- Mirrors ticket_photos: storage PATH persisted (not a baked signed URL,
-- which would 403 after expiry), signed URLs minted on demand for display.
-- One-way append — no update/delete policy, since a photo is evidence, not
-- an editable field.
-- =============================================================================

create table public.maintenance_work_order_photos (
  id            text primary key,
  work_order_id text not null references public.maintenance_work_orders (id) on delete cascade,
  mechanic_id   uuid references public.profiles (id) on delete set null,
  photo_url     text not null,
  uploaded_at   timestamptz not null default now()
);
create index maintenance_wo_photos_wo_idx on public.maintenance_work_order_photos (work_order_id);
alter table public.maintenance_work_order_photos enable row level security;

create policy maintenance_wo_photos_admin_all
  on public.maintenance_work_order_photos
  for all
  using (public.is_admin())
  with check (public.is_admin());

-- mechanics: see photos on any work order (matches maintenance_wo_mechanic_select's
-- whole-queue visibility).
create policy maintenance_wo_photos_mechanic_select
  on public.maintenance_work_order_photos
  for select
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'mechanic'
    )
  );

-- mechanics: attach a photo only to a work order currently assigned to them.
create policy maintenance_wo_photos_mechanic_insert_own
  on public.maintenance_work_order_photos
  for insert
  with check (
    exists (
      select 1 from public.maintenance_work_orders wo
      where wo.id = work_order_id and wo.assigned_mechanic_id = auth.uid()
    )
  );

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'wo-photos',
  'wo-photos',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

create policy "wo_photos_admin_all" on storage.objects
  for all
  using (bucket_id = 'wo-photos' and is_admin())
  with check (bucket_id = 'wo-photos' and is_admin());

create policy "wo_photos_mechanic_all" on storage.objects
  for all
  using (bucket_id = 'wo-photos' and current_role_value() = 'mechanic')
  with check (bucket_id = 'wo-photos' and current_role_value() = 'mechanic');

notify pgrst, 'reload schema';
