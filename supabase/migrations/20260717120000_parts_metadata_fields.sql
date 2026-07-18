-- =============================================================================
-- Parts metadata: location, category, manufacturer, and vendor cross-reference
-- fields on inventory_items.
--
-- Client feedback (Parts item 10 + others): "No ability to enter locations",
-- "No relationship with vendors", "No Part categories" (Fleetio comparison),
-- "We need Manufacturer part number fields, alternative part number fields,
-- supplier and alternative supplier fields." supplier_id already existed on
-- this table but was never exposed in the Add/Edit Part forms — this
-- migration adds the missing columns; the form wiring is a client-only
-- change (no RLS impact — inventory_admin_all / inventory_mechanic_all
-- already cover full read/write on this table).
--
-- All plain text, no new lookup tables: there's no suppliers or categories
-- table in this schema (supplier_id is already a loose string reference,
-- not a FK), so these follow the same convention rather than introducing
-- relational structure the client didn't ask for here.
-- =============================================================================

alter table public.inventory_items
  add column if not exists location text not null default '',
  add column if not exists category text not null default '',
  add column if not exists manufacturer text not null default '',
  add column if not exists manufacturer_part_number text not null default '',
  add column if not exists alternative_part_number text not null default '',
  add column if not exists alternative_supplier_id text;

notify pgrst, 'reload schema';
