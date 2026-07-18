-- =============================================================================
-- Assign parts to a vehicle or a person, and transfer them.
--
-- Client feedback (Parts item 8): "No ability to assign to users/operators/
-- vehicles/transfer." Also Fleetio pressure point #4: "isn't designed to
-- manage parts that may be assigned to vehicles or actual operators/users
-- ... this functionality would give us additional abilities to monitor some
-- expensive equipment that again seem to be displaced at the worst possible
-- times."
--
-- Mutually exclusive by CHECK constraint: a part is on exactly one truck,
-- checked out to exactly one person, or sitting in the spare pool (both
-- null) — never both at once. "Transfer" isn't a separate action; it's
-- just editing this assignment again, same UX as reassigning a Tool
-- between vehicles (20260716211149_mechanic_workshop_manager_tier.sql and
-- friends already established that pattern for the tools table).
-- =============================================================================

alter table public.inventory_items
  add column if not exists assigned_vehicle_id text references public.vehicles(id) on delete set null,
  add column if not exists assigned_user_id uuid references public.profiles(id) on delete set null,
  add constraint inventory_items_assignment_exclusive
    check (assigned_vehicle_id is null or assigned_user_id is null);

create index if not exists inventory_items_assigned_vehicle_idx
  on public.inventory_items (assigned_vehicle_id) where assigned_vehicle_id is not null;
create index if not exists inventory_items_assigned_user_idx
  on public.inventory_items (assigned_user_id) where assigned_user_id is not null;

notify pgrst, 'reload schema';
