-- =============================================================================
-- Part photo upload.
--
-- Client feedback: "Create part doesn't have Supplier reference or ability
-- to add photo" / "No ability to add photos, photos need to be imported as
-- so much work has been done to add them." This adds the storage bucket +
-- column; the import side (bulk-attaching photos someone already has on
-- disk from the old system) is a separate, larger tool this doesn't build —
-- this covers the missing one-at-a-time "add photo" ability the client
-- flagged twice.
--
-- Mirrors the ticket-photos bucket in
-- 20260602064820_sprint1_logs_and_storage.sql: private bucket, storage PATH
-- persisted (not a baked signed URL, which would 403 after expiry), signed
-- URLs minted on demand for display. RLS follows inventory_items' own
-- role split (inventory_admin_all / inventory_mechanic_all — both full
-- access, no per-owner scoping needed since parts aren't owned by a single
-- user the way a driver's ticket photo is).
-- =============================================================================

alter table public.inventory_items
  add column if not exists photo_url text not null default '';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'part-photos',
  'part-photos',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

create policy "part_photos_admin_all" on storage.objects
  for all
  using (bucket_id = 'part-photos' and is_admin())
  with check (bucket_id = 'part-photos' and is_admin());

create policy "part_photos_mechanic_all" on storage.objects
  for all
  using (bucket_id = 'part-photos' and current_role_value() = 'mechanic')
  with check (bucket_id = 'part-photos' and current_role_value() = 'mechanic');

notify pgrst, 'reload schema';
