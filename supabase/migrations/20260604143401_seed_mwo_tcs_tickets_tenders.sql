-- =============================================================================
-- Seed data for tables that were empty after the foundation seed:
--   maintenance_work_orders, tool_checklist_submissions, tool_checklist_items,
--   ticket_photos, tenders.
--
-- These tables were either added in later sprints (maintenance_work_orders)
-- or omitted from the original scripts/seed-supabase.ts pass. ON CONFLICT
-- DO NOTHING makes re-runs safe.
--
-- Driver UUIDs follow the deterministic mapping from scripts/seed-supabase.ts:
--   D-01 -> 11111111-1111-1111-1111-000000000001
--   D-02 -> 11111111-1111-1111-1111-000000000002
--   D-03 -> 11111111-1111-1111-1111-000000000003
-- Mechanic UUIDs:
--   M-01 -> 22222222-2222-2222-2222-000000000001
-- Admin UUID: 6fffbf51-581f-4a12-adbc-93ce3fdc41ea
-- =============================================================================

-- =============================================================================
-- 1. maintenance_work_orders (MWO-01..04)
-- =============================================================================
INSERT INTO public.maintenance_work_orders (
  id, vehicle_id, reported_by, reported_from, source_inspection_id,
  issue_description, priority, status, assigned_mechanic_id,
  claimed_at, started_at, completed_at, parts_used, labor_hours, labor_notes,
  final_cost, completion_notes, created_at, updated_at
) VALUES
  ('MWO-01', 'TRK-14', NULL, 'admin', NULL,
   'Brake pads worn below 3mm — replace front + rear sets.',
   'high', 'queued', NULL,
   NULL, NULL, NULL, '[]'::jsonb, 0, '',
   NULL, NULL, '2025-05-13 09:15:00+00', '2025-05-13 09:15:00+00'),
  ('MWO-02', 'TRK-03', NULL, 'admin', NULL,
   'Coolant leak under cab — pressure-test the radiator.',
   'medium', 'claimed', '22222222-2222-2222-2222-000000000001'::uuid,
   '2025-05-14 08:00:00+00', NULL, NULL, '[]'::jsonb, 0, '',
   NULL, NULL, '2025-05-13 14:20:00+00', '2025-05-14 08:00:00+00'),
  ('MWO-03', 'TRK-11', NULL, 'admin', NULL,
   'Hydraulic lift slow on rear gate — bleed + check seals.',
   'medium', 'in_progress', '22222222-2222-2222-2222-000000000001'::uuid,
   '2025-05-14 09:00:00+00', '2025-05-14 09:15:00+00', NULL,
   '[{"inventoryItemId":"INV-A4","qty":1}]'::jsonb, 2,
   'Bled the rear gate cylinder; checking seal kit fit next.',
   NULL, NULL, '2025-05-13 16:00:00+00', '2025-05-14 09:15:00+00'),
  ('MWO-04', 'TRK-14', NULL, 'admin', NULL,
   'Engine oil top-up + filter swap — scheduled service.',
   'low', 'in_progress', '22222222-2222-2222-2222-000000000001'::uuid,
   '2025-05-14 07:30:00+00', '2025-05-14 07:45:00+00', NULL,
   '[]'::jsonb, 1, 'Drained old oil; new oil drum staged.',
   NULL, NULL, '2025-05-13 18:00:00+00', '2025-05-14 07:45:00+00')
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- 2. tool_checklist_submissions (TCS-01..03) — only insert rows whose
--    referenced vehicle exists in public.vehicles (FK target).
-- =============================================================================
INSERT INTO public.tool_checklist_submissions (
  id, driver_id, vehicle_id, kind, submitted_at, gps_lat, gps_lng
)
SELECT * FROM (VALUES
  ('TCS-01', '11111111-1111-1111-1111-000000000001'::uuid, 'TRK-07',
   'start_of_shift', '2025-05-15 08:42:00+00'::timestamptz, 43.6532, -79.3832),
  ('TCS-02', '11111111-1111-1111-1111-000000000002'::uuid, 'TRK-03',
   'start_of_shift', '2025-05-14 08:30:00+00'::timestamptz, 43.651, -79.347),
  ('TCS-03', '11111111-1111-1111-1111-000000000003'::uuid, 'TRK-11',
   'start_of_shift', '2025-05-13 07:55:00+00'::timestamptz, 43.672, -79.396)
) AS v(id, driver_id, vehicle_id, kind, submitted_at, gps_lat, gps_lng)
WHERE EXISTS (SELECT 1 FROM public.vehicles WHERE vehicles.id = v.vehicle_id)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- 3. tool_checklist_items — child rows for each TCS submission.
--    Items reference tool_id (text), which is the tools.id PK. We seed a
--    minimal set so /driver/tool-checklist + admin Forms inbox views render.
-- =============================================================================
INSERT INTO public.tool_checklist_items (submission_id, tool_id, status, notes)
SELECT s.id, t.id, t.condition,
       CASE WHEN t.condition = 'missing' THEN 'Need replacements' ELSE '' END
FROM (VALUES ('TCS-01'), ('TCS-02'), ('TCS-03')) AS s(id)
CROSS JOIN public.tools t
WHERE EXISTS (SELECT 1 FROM public.tool_checklist_submissions WHERE id = s.id)
  AND NOT EXISTS (
    SELECT 1 FROM public.tool_checklist_items ci
    WHERE ci.submission_id = s.id AND ci.tool_id = t.id
  );

-- =============================================================================
-- 4. ticket_photos (TP-01..02)
-- =============================================================================
INSERT INTO public.ticket_photos (
  id, job_id, driver_id, photo_url, weight, location,
  entered_by, status, uploaded_at
)
SELECT * FROM (VALUES
  ('TP-01', 'JOB-041', '11111111-1111-1111-1111-000000000001'::uuid,
   'https://placehold.co/400x600?text=Ticket', 14::numeric, 'Greenfield Tip',
   '6fffbf51-581f-4a12-adbc-93ce3fdc41ea'::uuid, 'entered'::public.ticket_photo_status,
   '2025-05-14 14:35:00+00'::timestamptz),
  ('TP-02', 'JOB-042', '11111111-1111-1111-1111-000000000002'::uuid,
   'https://placehold.co/400x600?text=Ticket', NULL::numeric, NULL,
   NULL::uuid, 'awaiting-entry'::public.ticket_photo_status,
   '2025-05-14 15:05:00+00'::timestamptz)
) AS v(id, job_id, driver_id, photo_url, weight, location, entered_by, status, uploaded_at)
WHERE EXISTS (SELECT 1 FROM public.jobs WHERE jobs.id = v.job_id)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- 5. tenders (TND-01..03) — seed three demo entries the admin /tenders page
--    can display. Real scraper runs will append more on the weekly cron.
-- =============================================================================
INSERT INTO public.tenders (id, source, title, url, closing_date, summary, scraped_at)
VALUES
  ('TND-01', 'City of Maple', 'Municipal waste haulage — Q3',
   'https://example.gov/tenders/01', '2025-06-15'::date,
   'Annual contract for municipal yard waste haulage.',
   '2025-05-12 03:00:00+00'),
  ('TND-02', 'Metro Infra', 'Bridge demo material removal',
   'https://example.com/tenders/02', '2025-06-30'::date,
   'Removal and disposal of concrete debris.',
   '2025-05-12 03:00:00+00'),
  ('TND-03', 'Stoneridge', 'Quarry overflow haulage',
   'https://example.com/tenders/03', '2025-07-10'::date,
   'Two-truck overflow contract, 6-month term.',
   '2025-05-12 03:00:00+00')
ON CONFLICT (id) DO NOTHING;
