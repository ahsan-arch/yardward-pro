-- ON CONFLICT can't use a partial unique index, so swap to a full unique
-- index. NULLs are still allowed (multiple NULL rows are fine), so unmapped
-- vehicles remain valid.
drop index if exists vehicles_geotab_device_id_unique;
create unique index vehicles_geotab_device_id_unique on vehicles (geotab_device_id);
