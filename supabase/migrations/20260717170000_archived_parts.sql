-- =============================================================================
-- Archived parts listing.
--
-- Client feedback (First Impressions / obvious-missing list, page 2):
-- "Archived parts listing" — a retired/superseded part currently has no way
-- to be taken out of the active catalog other than deleting the row
-- outright, which would break every historical reference to it (purchase
-- requests, work-order parts_used, maintenance logs all point at
-- inventory_items.id). Archiving is a soft-hide, not a delete: the row and
-- its history stay intact, it just stops showing up in the active list,
-- the low-stock count, and every part-picker (mechanic adjust, work-order
-- parts, the inline PR stock-check).
-- =============================================================================

alter table public.inventory_items
  add column if not exists archived boolean not null default false;

create index if not exists inventory_items_archived_idx
  on public.inventory_items (archived) where archived = true;

notify pgrst, 'reload schema';
