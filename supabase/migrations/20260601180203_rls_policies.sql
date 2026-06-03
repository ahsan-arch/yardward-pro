-- =============================================================================
-- YardwardPro · Row-level security policies
--
-- Access model:
--   admin    · sees and writes everything
--   driver   · sees their own profile, their own forms/submissions/tokens,
--              jobs/work orders assigned to them, vehicle they drive
--   mechanic · sees vehicles, maintenance, tools, inventory, their own POs
-- =============================================================================

-- profiles --------------------------------------------------------------------
create policy profiles_admin_all on profiles
  for all using (is_admin()) with check (is_admin());
create policy profiles_self_read on profiles
  for select using (id = auth.uid());
create policy profiles_self_update on profiles
  for update using (id = auth.uid()) with check (id = auth.uid() and role = current_role_value());

-- drivers / mechanics ---------------------------------------------------------
create policy drivers_admin_all on drivers
  for all using (is_admin()) with check (is_admin());
create policy drivers_self_read on drivers
  for select using (id = auth.uid());

create policy mechanics_admin_all on mechanics
  for all using (is_admin()) with check (is_admin());
create policy mechanics_self_read on mechanics
  for select using (id = auth.uid());

-- clients ---------------------------------------------------------------------
create policy clients_admin_all on clients
  for all using (is_admin()) with check (is_admin());
create policy clients_driver_read on clients
  for select using (
    exists (select 1 from jobs j where j.client_id = clients.id and j.driver_id = auth.uid())
  );

-- rate_tables / line items ----------------------------------------------------
create policy rate_tables_admin_all on rate_tables
  for all using (is_admin()) with check (is_admin());
create policy rate_line_items_admin_all on rate_line_items
  for all using (is_admin()) with check (is_admin());

-- vehicles --------------------------------------------------------------------
create policy vehicles_admin_all on vehicles
  for all using (is_admin()) with check (is_admin());
create policy vehicles_driver_read on vehicles
  for select using (driver_id = auth.uid());
create policy vehicles_mechanic_read on vehicles
  for select using (current_role_value() = 'mechanic');

-- tools -----------------------------------------------------------------------
create policy tools_admin_all on tools
  for all using (is_admin()) with check (is_admin());
create policy tools_mechanic_all on tools
  for all using (current_role_value() = 'mechanic') with check (current_role_value() = 'mechanic');
create policy tools_driver_read on tools
  for select using (
    exists (select 1 from vehicles v where v.id = tools.vehicle_id and v.driver_id = auth.uid())
  );

-- maintenance_logs ------------------------------------------------------------
create policy maintenance_admin_all on maintenance_logs
  for all using (is_admin()) with check (is_admin());
create policy maintenance_mechanic_all on maintenance_logs
  for all using (current_role_value() = 'mechanic') with check (current_role_value() = 'mechanic');
create policy maintenance_driver_read on maintenance_logs
  for select using (
    exists (select 1 from vehicles v where v.id = maintenance_logs.vehicle_id and v.driver_id = auth.uid())
  );

-- fuel_logs -------------------------------------------------------------------
create policy fuel_admin_all on fuel_logs
  for all using (is_admin()) with check (is_admin());
create policy fuel_driver_read on fuel_logs
  for select using (driver_id = auth.uid());
create policy fuel_driver_insert on fuel_logs
  for insert with check (driver_id = auth.uid());

-- jobs ------------------------------------------------------------------------
create policy jobs_admin_all on jobs
  for all using (is_admin()) with check (is_admin());
create policy jobs_driver_read on jobs
  for select using (driver_id = auth.uid());

-- work_orders -----------------------------------------------------------------
create policy work_orders_admin_all on work_orders
  for all using (is_admin()) with check (is_admin());
create policy work_orders_driver_read on work_orders
  for select using (driver_id = auth.uid());
create policy work_orders_driver_insert on work_orders
  for insert with check (driver_id = auth.uid() and status = 'pending');

-- invoice_data + line items ---------------------------------------------------
create policy invoice_data_admin_all on invoice_data
  for all using (is_admin()) with check (is_admin());
create policy invoice_line_items_admin_all on invoice_line_items
  for all using (is_admin()) with check (is_admin());

-- time_entries ----------------------------------------------------------------
create policy time_entries_admin_all on time_entries
  for all using (is_admin()) with check (is_admin());
create policy time_entries_driver_read on time_entries
  for select using (driver_id = auth.uid());
create policy time_entries_driver_write on time_entries
  for insert with check (driver_id = auth.uid());
create policy time_entries_driver_update on time_entries
  for update using (driver_id = auth.uid()) with check (driver_id = auth.uid());

-- tool_checklist_submissions + items ------------------------------------------
create policy tcs_admin_all on tool_checklist_submissions
  for all using (is_admin()) with check (is_admin());
create policy tcs_mechanic_read on tool_checklist_submissions
  for select using (current_role_value() = 'mechanic');
create policy tcs_driver_read on tool_checklist_submissions
  for select using (driver_id = auth.uid());
create policy tcs_driver_insert on tool_checklist_submissions
  for insert with check (driver_id = auth.uid());

create policy tci_admin_all on tool_checklist_items
  for all using (is_admin()) with check (is_admin());
create policy tci_owner_read on tool_checklist_items
  for select using (
    exists (
      select 1 from tool_checklist_submissions s
      where s.id = tool_checklist_items.submission_id
        and (s.driver_id = auth.uid() or current_role_value() = 'mechanic')
    )
  );
create policy tci_driver_insert on tool_checklist_items
  for insert with check (
    exists (
      select 1 from tool_checklist_submissions s
      where s.id = tool_checklist_items.submission_id and s.driver_id = auth.uid()
    )
  );

-- purchase_requests -----------------------------------------------------------
create policy pr_admin_all on purchase_requests
  for all using (is_admin()) with check (is_admin());
create policy pr_mechanic_read on purchase_requests
  for select using (mechanic_id = auth.uid());
create policy pr_mechanic_insert on purchase_requests
  for insert with check (mechanic_id = auth.uid() and status = 'pending');

-- inventory_items -------------------------------------------------------------
create policy inventory_admin_all on inventory_items
  for all using (is_admin()) with check (is_admin());
create policy inventory_mechanic_all on inventory_items
  for all using (current_role_value() = 'mechanic') with check (current_role_value() = 'mechanic');

-- sms_logs --------------------------------------------------------------------
create policy sms_logs_admin_all on sms_logs
  for all using (is_admin()) with check (is_admin());
create policy sms_logs_driver_read on sms_logs
  for select using (driver_id = auth.uid());

-- notifications ---------------------------------------------------------------
create policy notifications_admin_all on notifications
  for all using (is_admin()) with check (is_admin());
create policy notifications_self_read on notifications
  for select using (user_id = auth.uid());
create policy notifications_self_update on notifications
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- driver_tokens ---------------------------------------------------------------
create policy driver_tokens_admin_all on driver_tokens
  for all using (is_admin()) with check (is_admin());
create policy driver_tokens_self_read on driver_tokens
  for select using (driver_id = auth.uid());

-- ticket_photos ---------------------------------------------------------------
create policy ticket_photos_admin_all on ticket_photos
  for all using (is_admin()) with check (is_admin());
create policy ticket_photos_driver_read on ticket_photos
  for select using (driver_id = auth.uid());
create policy ticket_photos_driver_insert on ticket_photos
  for insert with check (driver_id = auth.uid());

-- tenders ---------------------------------------------------------------------
create policy tenders_admin_all on tenders
  for all using (is_admin()) with check (is_admin());

-- vehicle_inspections + items -------------------------------------------------
create policy inspections_admin_all on vehicle_inspections
  for all using (is_admin()) with check (is_admin());
create policy inspections_mechanic_read on vehicle_inspections
  for select using (current_role_value() = 'mechanic');
create policy inspections_driver_read on vehicle_inspections
  for select using (driver_id = auth.uid());
create policy inspections_driver_insert on vehicle_inspections
  for insert with check (driver_id = auth.uid());

create policy inspection_items_admin_all on inspection_items
  for all using (is_admin()) with check (is_admin());
create policy inspection_items_owner_read on inspection_items
  for select using (
    exists (
      select 1 from vehicle_inspections i
      where i.id = inspection_items.inspection_id
        and (i.driver_id = auth.uid() or current_role_value() = 'mechanic')
    )
  );
create policy inspection_items_driver_insert on inspection_items
  for insert with check (
    exists (
      select 1 from vehicle_inspections i
      where i.id = inspection_items.inspection_id and i.driver_id = auth.uid()
    )
  );

-- ticket_transactions + ticket_replenishments --------------------------------
create policy ticket_txns_admin_all on ticket_transactions
  for all using (is_admin()) with check (is_admin());
create policy ticket_reps_admin_all on ticket_replenishments
  for all using (is_admin()) with check (is_admin());
