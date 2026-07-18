-- =============================================================================
-- Passenger manifest capture on the start-of-day form.
--
-- Client feedback (Driver item 13): "Passengers in vehicle?" was a bare
-- yes/no toggle — flipping it captured nothing about WHO was riding along,
-- and (like the PPE toggle fixed in 20260717090000_ppe_missing_report.sql)
-- the value never even made it into the submit payload. For a safety
-- manifest, the toggle alone is useless — in an incident, dispatch needs
-- names, not just a boolean.
--
-- No notification routing here (unlike PPE) — the client feedback for this
-- item was specifically about capturing who's on board, not alerting
-- management in real time.
-- =============================================================================

alter table public.time_entries
  add column if not exists passenger_names text[] not null default '{}';

notify pgrst, 'reload schema';
