-- =============================================================================
-- Core returns / surcharge credit audit trail.
--
-- Client feedback (Parts, page 6): "A customer returns a pump. It has a core
-- value. The pump is returned to the supplier. The supplier issues a
-- credit. I need the system to track every stage automatically until the
-- credit is received and applied e.g. Returns Note printed and logged in
-- the system, when the credit is received a way to balance that credit to
-- zero without affecting the stock, a listing/record of the outstanding
-- credits with RTS notes etc."
--
-- Three-stage lifecycle, one row per core:
--   received              — the core came back from a customer/job, sitting
--                            in the shop, credit not yet claimed
--   returned_to_supplier  — sent back to the supplier for the deposit,
--                            RTS reference/note stamped
--   credited              — the supplier's credit landed; balanced to zero
--
-- Deliberately does NOT touch inventory_items.qty_on_hand at any stage —
-- the client was explicit that resolving a credit must not affect stock.
-- This is a financial/paper trail sitting alongside the parts catalog, not
-- a stock movement.
-- =============================================================================

create type public.core_return_status as enum ('received', 'returned_to_supplier', 'credited');

create table public.core_returns (
  id                      text primary key,
  part_description        text not null,
  inventory_item_id       text references public.inventory_items(id) on delete set null,
  core_value              numeric(10,2) not null default 0,
  customer_name           text not null default '',
  status                  public.core_return_status not null default 'received',
  received_at             date not null default current_date,
  supplier_id             text,
  rts_reference           text not null default '',
  rts_at                  timestamptz,
  credit_amount           numeric(10,2),
  credited_at             timestamptz,
  notes                   text not null default '',
  created_by              uuid references public.profiles(id) on delete set null,
  created_at              timestamptz not null default now()
);

create index core_returns_status_idx on public.core_returns (status);
create index core_returns_inventory_item_idx on public.core_returns (inventory_item_id);

alter table public.core_returns enable row level security;

-- Same role split as inventory_items itself (admin + mechanic full access —
-- mechanics are the ones physically handling a returned core in the shop).
create policy core_returns_admin_all on public.core_returns
  for all using (is_admin()) with check (is_admin());
create policy core_returns_mechanic_all on public.core_returns
  for all using (current_role_value() = 'mechanic') with check (current_role_value() = 'mechanic');

notify pgrst, 'reload schema';
