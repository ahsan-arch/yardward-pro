# Deploy notes — audit fixes (2026-06-16)

This batch fixes the gaps surfaced by the full-app audit. Most fixes are code +
**new** migrations (nothing edits an already-applied migration). Migrations are
**not** auto-applied — apply them, then deploy as usual.

## 1. Apply the new migrations

```bash
supabase db push   # or your normal migration step
```

New migrations in this batch (all additive / idempotent):

| Migration | Fixes |
|---|---|
| `20260616100000_vehicles_next_service_due_text.sql` | **Blocker:** preventive-maintenance alerts never fired. `vehicles.next_service_due` was a `date` column but the whole app (types, mappers, mock data, PM edge function) treats it as text like `"90,000 km"`. Alters the column to `text`. The PM function code is already correct — no redeploy needed. **Note:** the column change alone is not enough — there must also be a parseable value in it. This batch adds the write paths (below), but **existing** rows are NULL until re-seeded or edited. After deploy, set each vehicle's "Next service" on its detail page (or re-run `scripts/seed-supabase.ts` for demo data). |
| `20260616110000_move_to_dead_letter_rpc.sql` | **Blocker:** failed offline submissions never reached admin. Adds `move_to_dead_letter()` (SECURITY DEFINER) so a driver's exhausted submission can be parked for review at `/admin/errors`. `api.moveToDeadLetter` now calls it. |
| `20260616120000_jobs_driver_read_hide_drafts.sql` | Draft jobs were readable by their assigned driver via the API. Recreates `jobs_driver_read` with `and status <> 'draft'`. |
| `20260616130000_time_entry_movement_correlation.sql` | The GPS-mismatch report never populated (`vehicle_movement_correlation` was always `'pending'`). Adds a guarded `before insert/update` trigger that sets `matches`/`mismatch` by comparing clock GPS to the driver's assigned vehicle position (~750 m), leaving `'pending'` when there's no position to compare. Cannot block a clock-in. |

Code changes shipped alongside (deploy the app + `supabase functions deploy` as usual — no function bodies changed, only app code):
- **PM write paths** (so the column actually carries a parseable target): `scripts/seed-supabase.ts` writes the raw `"<n> km/hrs"` text (was nulled by `parseDate`); `api.createVehicle` accepts + persists `nextServiceDue`; the Add-vehicle dialog gained a "Next service due" field; the vehicle detail page gained an inline editor (new `api.updateVehicle`).
- `api.moveToDeadLetter` → calls the new RPC.
- `api.topUpTickets` → auto-bill now pushes the replenishment invoice to QuickBooks (was created `pending` and never pushed).
- `api.approveWorkOrder` → advances the parent job to `completed` (RLS-safe, admin-side; best-effort).
- `admin.clients` client sheet → new **Prepaid tickets** editor (enable program, threshold/bundle/price, auto-bill, report frequency) calling the existing `api.updateClientTicketSettings`. This is now the only in-app way to enroll a brand-new client into prepaid.

## 2. Operational steps (require live credentials — do these yourself)

These two can't be done from code; they need secrets I don't (and shouldn't)
handle.

### a. Provision the cron Vault key (else all 4 pg_cron schedules 401 silently)

The cron schedules POST to edge functions using `service_role_key` from Vault,
which no migration seeds. Run **once** as `service_role` (Supabase Dashboard →
SQL Editor, or any service-role connection):

```sql
select public.bootstrap_vault_service_role_key('<YOUR_SERVICE_ROLE_KEY>');
```

(The helper RPC already exists — migration `20260602024607`. It's revoked from
public/anon/authenticated, so it must be called with the service role.)

Verify a schedule fires afterward, e.g. by checking `cron.job_run_details` or
that preventive-maintenance / weekly-digest notifications appear.

### b. Rotate the seeded admin password

`supabase/migrations/20260601181236_seed_admin_user.sql` ships a known default
(`ChangeMe!2026`). Rotate it for any real deployment:

- Supabase Dashboard → Authentication → Users → the seeded admin → **Reset
  password** (or send a reset email), **or**
- have that admin use the in-app **Forgot password?** flow.

## 3. Verification done in this batch

- `tsc --noEmit` clean · `eslint` clean on changed files.
- Full Playwright e2e suite (mock mode) — see commit message for the count.
- Both blockers were confirmed against source before fixing; the migrations are
  additive and the dead-letter / draft-privacy / correlation changes are RLS-safe.

## Still open (fast-follow, not in this batch)

- Job lifecycle: only the `→ completed` transition (on approval) is wired here.
  An `→ active` transition on job start and admin cancel/delay controls are not.
- Consumed parts (`parts_used`) still don't debit inventory on WO completion.
- No UI yet to map a Geotab device id to a vehicle (DB-only).
- The GPS correlation uses a simple distance heuristic (~750 m), not the
  time-windowed telematics check implied by `gps_tolerance_minutes`.
