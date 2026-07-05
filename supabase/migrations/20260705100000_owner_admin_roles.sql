-- =============================================================================
-- Owner admin tier + named custom admin roles (per-tab access control).
--
-- Feature: one or more "owner" admins keep full access and are the only ones
-- who may manage which admin tabs other admins can see. Access is resolved
-- client-side as: is_owner -> ALL; else allowed_tabs_override (if not null,
-- fully replaces the role); else admin_roles.allowed_tabs; else (both null)
-- -> ALL. Tab keys are defined in src/lib/admin-tabs.ts (client source of
-- truth); unknown keys are ignored at resolution time, so no CHECK here.
--
-- Safety invariant: every existing admin is seeded is_owner = true (below,
-- BEFORE the guard triggers are created), so nothing changes for anyone until
-- an owner actively restricts someone. UI hiding is phase 1; RLS hardening of
-- financial data tables is a later phase — but the permission ASSIGNMENT data
-- itself is server-enforced here, because profiles_admin_all (rls_policies)
-- lets any admin write any profile row via REST, and without these triggers a
-- restricted admin could simply PATCH their own row back to full access.
-- =============================================================================

-- ---- 1. Access-control columns on profiles -------------------------------
alter table public.profiles
  add column if not exists is_owner boolean not null default false,
  add column if not exists admin_role_id uuid,
  add column if not exists allowed_tabs_override text[];

-- ---- 2. Named custom roles ------------------------------------------------
create table if not exists public.admin_roles (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  allowed_tabs text[] not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.admin_roles enable row level security;

create or replace function public.admin_roles_set_updated_at()
  returns trigger
  language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists admin_roles_set_updated_at on public.admin_roles;
create trigger admin_roles_set_updated_at
  before update on public.admin_roles
  for each row
  execute function public.admin_roles_set_updated_at();

-- ---- 3. FK (restrict: a role in use can never be silently deleted, which
--         would flip its members back to full access) -----------------------
alter table public.profiles
  drop constraint if exists profiles_admin_role_id_fkey;
alter table public.profiles
  add constraint profiles_admin_role_id_fkey
  foreign key (admin_role_id) references public.admin_roles (id)
  on delete restrict;

-- ---- 4. is_owner() helper (mirrors is_admin) ------------------------------
create or replace function public.is_owner() returns boolean
  language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role = 'admin' and is_owner and status = 'active'
  );
$$;

revoke all on function public.is_owner() from public, anon;
grant execute on function public.is_owner() to authenticated, service_role;

-- ---- 5. Seed BEFORE creating the guard triggers ---------------------------
-- Every current admin becomes an owner: exact current capability is preserved
-- and the new triggers are no-ops for them. The real owner demotes the others
-- from the Settings UI afterwards.
update public.profiles set is_owner = true where role = 'admin';

-- ---- 6. Guard trigger: access columns are owner-only ----------------------
-- auth.role() IS NULL means this is not a PostgREST request at all (SQL
-- editor / migrations / psql) — a trusted direct-DB context, exempt like
-- service_role. PostgREST always stamps a role (anon/authenticated/service),
-- and anon has no UPDATE policy on profiles anyway.
create or replace function public.enforce_profile_access_columns_owner_only()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  -- Serialize owner-count transitions so two concurrent demotions of the
  -- final two owners can't both pass the "another owner still exists" check
  -- below and leave the org with zero owners. Same key in the delete guard.
  perform pg_advisory_xact_lock(hashtext('owner_admin_guard'));

  if (new.is_owner is distinct from old.is_owner)
     or (new.admin_role_id is distinct from old.admin_role_id)
     or (new.allowed_tabs_override is distinct from old.allowed_tabs_override) then
    if not (public.is_owner() or auth.role() = 'service_role' or auth.role() is null) then
      raise exception 'Only an owner admin can change admin access settings'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- Owner rows can only be suspended/deactivated by another owner. Without
  -- this, a restricted admin could use the blanket profiles_admin_all policy
  -- to flip an owner's status and lock the org's access management (a
  -- denial-of-service, not a privilege grab — but cheap to close here).
  if old.is_owner and (new.status is distinct from old.status) then
    if not (public.is_owner() or auth.role() = 'service_role' or auth.role() is null) then
      raise exception 'Only an owner admin can change an owner admin''s status'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- Last-owner protection: the org must always keep at least one active admin
  -- owner. Deliberately NO service_role/direct-SQL exemption — losing the last
  -- owner locks everyone out of access management, a footgun even for tooling.
  if (old.is_owner and old.role = 'admin' and old.status = 'active')
     and not (new.is_owner and new.role = 'admin' and new.status = 'active') then
    if not exists (
      select 1 from public.profiles p
      where p.id <> old.id and p.is_owner and p.role = 'admin' and p.status = 'active'
    ) then
      raise exception 'Cannot remove the last owner admin'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists profiles_access_columns_owner_only on public.profiles;
create trigger profiles_access_columns_owner_only
  before update on public.profiles
  for each row
  execute function public.enforce_profile_access_columns_owner_only();

-- ---- 7. Guard trigger: deleting owner rows --------------------------------
create or replace function public.enforce_profile_owner_delete_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtext('owner_admin_guard'));

  if old.is_owner and old.role = 'admin' and old.status = 'active' then
    if not exists (
      select 1 from public.profiles p
      where p.id <> old.id and p.is_owner and p.role = 'admin' and p.status = 'active'
    ) then
      raise exception 'Cannot delete the last owner admin'
        using errcode = 'insufficient_privilege';
    end if;
    if not (public.is_owner() or auth.role() = 'service_role' or auth.role() is null) then
      raise exception 'Only an owner admin can delete an owner admin profile'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return old;
end $$;

drop trigger if exists profiles_owner_delete_guard on public.profiles;
create trigger profiles_owner_delete_guard
  before delete on public.profiles
  for each row
  execute function public.enforce_profile_owner_delete_guard();

-- ---- 8. Tighten role changes to owner-only --------------------------------
-- Same function name/binding as 20260602123356 (CREATE OR REPLACE — the
-- existing BEFORE UPDATE OF role trigger keeps pointing at it). Previously any
-- admin could change roles; now only owners (or service_role / direct SQL).
-- No observable change today because every existing admin was just seeded as
-- an owner. Closes: restricted admin promotes an accomplice to full admin.
create or replace function public.enforce_profile_role_change_admin_only()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  if new.role is distinct from old.role then
    if not (public.is_owner() or auth.role() = 'service_role' or auth.role() is null) then
      raise exception 'Only an owner admin can change a profile role (attempted % -> %)', old.role, new.role
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end $$;

-- ---- 9. admin_roles RLS ----------------------------------------------------
-- Every admin may READ roles (their own client needs to resolve its tab list
-- via the profiles -> admin_roles embed); only owners may write.
drop policy if exists admin_roles_admin_read on public.admin_roles;
create policy admin_roles_admin_read on public.admin_roles
  for select using (public.is_admin());

drop policy if exists admin_roles_owner_all on public.admin_roles;
create policy admin_roles_owner_all on public.admin_roles
  for all using (public.is_owner()) with check (public.is_owner());

-- ---- 10. PostgREST schema cache reload ------------------------------------
-- Mandatory when applied via the SQL editor: without it PostgREST 404s the new
-- columns/table and the frontend's enriched profile select would fail.
notify pgrst, 'reload schema';
