-- =============================================================================
-- Parts low-stock / minimum-stock alerts.
--
-- Client feedback: "Parts low stock / minimum stock alerts?" — the app
-- already surfaced low stock passively everywhere (filter chips on both
-- inventory pages, a dashboard tile) but nothing ever pushed a notification;
-- an admin only found out by remembering to go look. This adds an edge
-- trigger (fires once per crossing, not on every subsequent save while
-- already low) that fans a notification out to every admin — same
-- SECURITY DEFINER pattern as trg_time_entries_notify_ppe_missing in
-- 20260717090000_ppe_missing_report.sql, since neither an admin's own
-- update nor a mechanic's stock adjust has an INSERT policy on
-- notifications for another user.
--
-- Fires on both INSERT (a part logged already at/below its reorder point)
-- and UPDATE (stock drops through the line, or reorder_point is raised
-- above current stock) — "was it low before, is it low now" on both sides
-- of the same row so raising the reorder point counts as a crossing too.
-- =============================================================================

create or replace function public.trg_inventory_items_notify_low_stock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  was_low boolean;
  is_low boolean := NEW.qty_on_hand <= NEW.reorder_point;
begin
  was_low := (TG_OP = 'UPDATE') and (OLD.qty_on_hand <= OLD.reorder_point);
  if is_low and not was_low then
    insert into public.notifications (id, user_id, type, body, link, created_at)
    select
      gen_random_uuid()::text,
      p.id,
      'alert',
      format(
        'Low stock: %s (%s) — %s on hand, reorder point %s.',
        NEW.name, NEW.sku, NEW.qty_on_hand, NEW.reorder_point
      ),
      '/admin/inventory',
      now()
    from public.profiles p
    where p.role = 'admin';
  end if;
  return NEW;
end;
$$;

drop trigger if exists inventory_items_notify_low_stock_ins on public.inventory_items;
create trigger inventory_items_notify_low_stock_ins
  after insert on public.inventory_items
  for each row
  execute function public.trg_inventory_items_notify_low_stock();

drop trigger if exists inventory_items_notify_low_stock_upd on public.inventory_items;
create trigger inventory_items_notify_low_stock_upd
  after update on public.inventory_items
  for each row
  execute function public.trg_inventory_items_notify_low_stock();

notify pgrst, 'reload schema';
