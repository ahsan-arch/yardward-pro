-- =============================================================================
-- YardwardPro · Initial schema
-- All domain entities used by the CRM. RLS is ENABLED on every table here;
-- policies live in a separate migration so this file stays readable.
-- =============================================================================

create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
create type user_role               as enum ('admin', 'driver', 'mechanic');
create type user_status             as enum ('active', 'inactive', 'suspended');
create type vehicle_type            as enum ('truck', 'trailer', 'equipment');
create type vehicle_status          as enum ('operational', 'maintenance', 'out-of-service');
create type tool_condition          as enum ('ok', 'missing', 'damaged');
create type job_status              as enum ('scheduled', 'active', 'completed', 'delayed', 'cancelled');
create type work_order_status       as enum ('pending', 'approved', 'rejected');
create type qbo_sync_status         as enum ('not-synced', 'pending', 'synced', 'failed');
create type invoice_kind            as enum ('work-order', 'ticket-replenishment');
create type purchase_request_status as enum ('pending', 'approved', 'rejected', 'ordered');
create type urgency_level           as enum ('low', 'medium', 'high');
create type sms_delivery_status     as enum ('queued', 'sent', 'delivered', 'failed');
create type notification_type       as enum ('job', 'approval', 'alert', 'system');
create type token_scope             as enum ('forms', 'job', 'shift');
create type ticket_photo_status     as enum ('awaiting-entry', 'entered');
create type inspection_item_status  as enum ('ok', 'issue');
create type movement_correlation    as enum ('matches', 'mismatch', 'pending');
create type ticket_txn_kind         as enum ('debit', 'credit', 'adjustment');
create type ticket_report_frequency as enum ('off', 'daily', 'weekly', 'monthly');

-- -----------------------------------------------------------------------------
-- profiles · 1:1 with auth.users, holds role + display data
-- -----------------------------------------------------------------------------
create table profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null unique,
  name        text not null,
  phone       text not null default '',
  role        user_role not null,
  status      user_status not null default 'active',
  created_at  timestamptz not null default now()
);
create index profiles_role_idx on profiles (role);
alter table profiles enable row level security;

create or replace function is_admin() returns boolean
  language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function current_role_value() returns user_role
  language sql stable security definer set search_path = public
as $$
  select role from profiles where id = auth.uid();
$$;

-- -----------------------------------------------------------------------------
-- drivers · profile extension for driver-specific fields
-- -----------------------------------------------------------------------------
create table drivers (
  id                     uuid primary key references profiles (id) on delete cascade,
  license_number         text not null,
  license_expiry         date not null,
  vehicle_assignment_id  text,
  current_token_id       text,
  initials               text not null default ''
);
alter table drivers enable row level security;

-- -----------------------------------------------------------------------------
-- mechanics · profile extension for mechanic-specific fields
-- -----------------------------------------------------------------------------
create table mechanics (
  id        uuid primary key references profiles (id) on delete cascade,
  specialty text not null default '',
  shop_id   text not null default ''
);
alter table mechanics enable row level security;

-- -----------------------------------------------------------------------------
-- clients · with prepaid dump tickets settings inlined
-- -----------------------------------------------------------------------------
create table clients (
  id                          text primary key,
  name                        text not null,
  contact_name                text not null,
  email                       text not null,
  phone                       text not null,
  billing_address             text not null,
  rate_table_id               text,
  notes                       text not null default '',
  status                      text not null default 'active' check (status in ('active', 'inactive')),
  tickets_enabled             boolean not null default false,
  tickets_balance             integer not null default 0,
  tickets_threshold           integer not null default 20,
  tickets_bundle_size         integer not null default 100,
  tickets_bundle_price        numeric(10,2) not null default 0,
  tickets_auto_bill_enabled   boolean not null default false,
  tickets_report_frequency    ticket_report_frequency not null default 'off',
  tickets_report_recipients   text[] not null default '{}',
  created_at                  timestamptz not null default now()
);
create index clients_status_idx on clients (status);
alter table clients enable row level security;

-- -----------------------------------------------------------------------------
-- rate_tables + rate_line_items
-- -----------------------------------------------------------------------------
create table rate_tables (
  id         text primary key,
  client_id  text not null references clients (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table rate_tables enable row level security;

alter table clients add constraint clients_rate_table_fk
  foreign key (rate_table_id) references rate_tables (id) on delete set null;

create table rate_line_items (
  id            uuid primary key default gen_random_uuid(),
  rate_table_id text not null references rate_tables (id) on delete cascade,
  description   text not null,
  unit          text not null check (unit in ('hour', 'tonne', 'load', 'flat')),
  rate          numeric(10,2) not null,
  surcharges    jsonb not null default '[]'::jsonb,
  position      integer not null default 0
);
create index rate_line_items_table_idx on rate_line_items (rate_table_id);
alter table rate_line_items enable row level security;

-- -----------------------------------------------------------------------------
-- vehicles
-- -----------------------------------------------------------------------------
create table vehicles (
  id                text primary key,
  name              text not null,
  plate             text not null,
  year              integer not null,
  type              vehicle_type not null,
  vin               text not null,
  odometer          integer not null default 0,
  engine_hours      integer not null default 0,
  last_service      date,
  next_service_due  date,
  driver_id         uuid references drivers (id) on delete set null,
  geotab_device_id  text,
  status            vehicle_status not null default 'operational',
  created_at        timestamptz not null default now()
);
create index vehicles_driver_idx on vehicles (driver_id);
create index vehicles_status_idx on vehicles (status);
alter table vehicles enable row level security;

alter table drivers add constraint drivers_vehicle_assignment_fk
  foreign key (vehicle_assignment_id) references vehicles (id) on delete set null;

-- -----------------------------------------------------------------------------
-- tools
-- -----------------------------------------------------------------------------
create table tools (
  id         text primary key,
  name       text not null,
  condition  tool_condition not null default 'ok',
  vehicle_id text references vehicles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index tools_vehicle_idx on tools (vehicle_id);
alter table tools enable row level security;

-- -----------------------------------------------------------------------------
-- maintenance_logs
-- -----------------------------------------------------------------------------
create table maintenance_logs (
  id           text primary key,
  vehicle_id   text not null references vehicles (id) on delete cascade,
  type         text not null,
  performed_by text not null,
  date         date not null,
  mileage      integer not null default 0,
  cost         numeric(10,2) not null default 0,
  notes        text not null default '',
  attachments  text[] not null default '{}',
  created_at   timestamptz not null default now()
);
create index maintenance_logs_vehicle_idx on maintenance_logs (vehicle_id);
alter table maintenance_logs enable row level security;

-- -----------------------------------------------------------------------------
-- fuel_logs
-- -----------------------------------------------------------------------------
create table fuel_logs (
  id         text primary key,
  vehicle_id text not null references vehicles (id) on delete cascade,
  date       date not null,
  gallons    numeric(10,2) not null,
  cost       numeric(10,2) not null,
  location   text not null,
  driver_id  uuid references drivers (id) on delete set null,
  created_at timestamptz not null default now()
);
create index fuel_logs_vehicle_idx on fuel_logs (vehicle_id);
create index fuel_logs_driver_idx on fuel_logs (driver_id);
alter table fuel_logs enable row level security;

-- -----------------------------------------------------------------------------
-- jobs
-- -----------------------------------------------------------------------------
create table jobs (
  id               text primary key,
  client_id        text not null references clients (id),
  location_address text not null,
  location_lat     double precision,
  location_lng     double precision,
  scheduled_at     timestamptz not null,
  duration_min     integer not null default 60,
  driver_id        uuid references drivers (id),
  vehicle_id       text references vehicles (id),
  status           job_status not null default 'scheduled',
  notes            text not null default '',
  created_by       uuid references profiles (id),
  created_at       timestamptz not null default now()
);
create index jobs_client_idx on jobs (client_id);
create index jobs_driver_idx on jobs (driver_id);
create index jobs_scheduled_idx on jobs (scheduled_at);
alter table jobs enable row level security;

-- -----------------------------------------------------------------------------
-- work_orders
-- -----------------------------------------------------------------------------
create table work_orders (
  id                  text primary key,
  job_id              text not null references jobs (id) on delete cascade,
  driver_id           uuid not null references drivers (id),
  work_performed      text not null default '',
  load_type           text not null default '',
  weight_tonnes       numeric(10,2) not null default 0,
  dump_site           text not null default '',
  gps_lat             double precision,
  gps_lng             double precision,
  gps_captured_at     timestamptz,
  foreman_signature   text not null default '',
  site_issues         boolean not null default false,
  site_issues_note    text not null default '',
  submitted_at        timestamptz not null default now(),
  status              work_order_status not null default 'pending',
  approved_by         uuid references profiles (id),
  approved_at         timestamptz,
  invoice_data_id     text
);
create index work_orders_job_idx on work_orders (job_id);
create index work_orders_driver_idx on work_orders (driver_id);
create index work_orders_status_idx on work_orders (status);
alter table work_orders enable row level security;

-- -----------------------------------------------------------------------------
-- invoice_data + invoice_line_items
-- -----------------------------------------------------------------------------
create table invoice_data (
  id              text primary key,
  work_order_id   text references work_orders (id),
  client_id       text not null references clients (id),
  kind            invoice_kind not null default 'work-order',
  total           numeric(10,2) not null default 0,
  qbo_sync_status qbo_sync_status not null default 'pending',
  qbo_invoice_id  text,
  created_at      timestamptz not null default now()
);
create index invoice_data_client_idx on invoice_data (client_id);
create index invoice_data_kind_idx on invoice_data (kind);
alter table invoice_data enable row level security;

alter table work_orders add constraint work_orders_invoice_fk
  foreign key (invoice_data_id) references invoice_data (id) on delete set null;

create table invoice_line_items (
  id              uuid primary key default gen_random_uuid(),
  invoice_data_id text not null references invoice_data (id) on delete cascade,
  description     text not null,
  qty             numeric(10,2) not null,
  rate            numeric(10,2) not null,
  amount          numeric(10,2) not null,
  position        integer not null default 0
);
create index invoice_line_items_invoice_idx on invoice_line_items (invoice_data_id);
alter table invoice_line_items enable row level security;

-- -----------------------------------------------------------------------------
-- time_entries
-- -----------------------------------------------------------------------------
create table time_entries (
  id                            text primary key,
  driver_id                     uuid not null references drivers (id) on delete cascade,
  clock_in                      timestamptz not null,
  clock_out                     timestamptz,
  gps_clock_in_lat              double precision,
  gps_clock_in_lng              double precision,
  gps_clock_out_lat             double precision,
  gps_clock_out_lng             double precision,
  vehicle_movement_correlation  movement_correlation not null default 'pending',
  flagged                       boolean not null default false,
  flag_reason                   text not null default ''
);
create index time_entries_driver_idx on time_entries (driver_id);
create index time_entries_flagged_idx on time_entries (flagged) where flagged = true;
alter table time_entries enable row level security;

-- -----------------------------------------------------------------------------
-- tool_checklist_submissions + items
-- -----------------------------------------------------------------------------
create table tool_checklist_submissions (
  id            text primary key,
  driver_id     uuid not null references drivers (id) on delete cascade,
  vehicle_id    text not null references vehicles (id),
  submitted_at  timestamptz not null default now(),
  gps_lat       double precision,
  gps_lng       double precision
);
create index tool_checklist_driver_idx on tool_checklist_submissions (driver_id);
alter table tool_checklist_submissions enable row level security;

create table tool_checklist_items (
  id            uuid primary key default gen_random_uuid(),
  submission_id text not null references tool_checklist_submissions (id) on delete cascade,
  tool_id       text not null references tools (id),
  status        tool_condition not null,
  notes         text not null default ''
);
create index tool_checklist_items_sub_idx on tool_checklist_items (submission_id);
alter table tool_checklist_items enable row level security;

-- -----------------------------------------------------------------------------
-- purchase_requests
-- -----------------------------------------------------------------------------
create table purchase_requests (
  id                   text primary key,
  mechanic_id          uuid not null references mechanics (id) on delete cascade,
  item                 text not null,
  reason               text not null,
  estimated_cost       numeric(10,2) not null default 0,
  urgency              urgency_level not null default 'medium',
  inventory_checked_at timestamptz,
  status               purchase_request_status not null default 'pending',
  approved_by          uuid references profiles (id),
  supplier_id          text,
  created_at           timestamptz not null default now()
);
create index purchase_requests_mechanic_idx on purchase_requests (mechanic_id);
create index purchase_requests_status_idx on purchase_requests (status);
alter table purchase_requests enable row level security;

-- -----------------------------------------------------------------------------
-- inventory_items
-- -----------------------------------------------------------------------------
create table inventory_items (
  id             text primary key,
  name           text not null,
  sku            text not null unique,
  qty_on_hand    integer not null default 0,
  qty_reserved   integer not null default 0,
  reorder_point  integer not null default 0,
  supplier_id    text,
  last_restocked date
);
alter table inventory_items enable row level security;

-- -----------------------------------------------------------------------------
-- sms_logs
-- -----------------------------------------------------------------------------
create table sms_logs (
  id                text primary key,
  driver_id         uuid references drivers (id) on delete set null,
  job_id            text references jobs (id) on delete set null,
  body              text not null,
  sent_at           timestamptz not null default now(),
  twilio_message_id text,
  delivery_status   sms_delivery_status not null default 'queued'
);
create index sms_logs_driver_idx on sms_logs (driver_id);
create index sms_logs_status_idx on sms_logs (delivery_status);
alter table sms_logs enable row level security;

-- -----------------------------------------------------------------------------
-- notifications
-- -----------------------------------------------------------------------------
create table notifications (
  id         text primary key,
  user_id    uuid not null references profiles (id) on delete cascade,
  type       notification_type not null,
  body       text not null,
  link       text,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on notifications (user_id);
create index notifications_unread_idx on notifications (user_id) where read_at is null;
alter table notifications enable row level security;

-- -----------------------------------------------------------------------------
-- driver_tokens
-- -----------------------------------------------------------------------------
create table driver_tokens (
  id         text primary key,
  driver_id  uuid not null references drivers (id) on delete cascade,
  token      text not null unique,
  scoped_to  token_scope not null,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index driver_tokens_token_idx on driver_tokens (token);
create index driver_tokens_driver_idx on driver_tokens (driver_id);
alter table driver_tokens enable row level security;

-- -----------------------------------------------------------------------------
-- ticket_photos
-- -----------------------------------------------------------------------------
create table ticket_photos (
  id          text primary key,
  job_id      text not null references jobs (id) on delete cascade,
  driver_id   uuid not null references drivers (id),
  photo_url   text not null,
  weight      numeric(10,2),
  location    text,
  entered_by  uuid references profiles (id),
  status      ticket_photo_status not null default 'awaiting-entry',
  uploaded_at timestamptz not null default now()
);
create index ticket_photos_job_idx on ticket_photos (job_id);
create index ticket_photos_status_idx on ticket_photos (status);
alter table ticket_photos enable row level security;

-- -----------------------------------------------------------------------------
-- tenders (scraped municipal bid postings)
-- -----------------------------------------------------------------------------
create table tenders (
  id           text primary key,
  source       text not null,
  title        text not null,
  url          text not null,
  closing_date date,
  summary      text not null default '',
  scraped_at   timestamptz not null default now()
);
create index tenders_closing_idx on tenders (closing_date);
alter table tenders enable row level security;

-- -----------------------------------------------------------------------------
-- vehicle_inspections + items
-- -----------------------------------------------------------------------------
create table vehicle_inspections (
  id                     text primary key,
  driver_id              uuid not null references drivers (id) on delete cascade,
  vehicle_id             text not null references vehicles (id),
  submitted_at           timestamptz not null default now(),
  gps_lat                double precision,
  gps_lng                double precision,
  gps_captured_at        timestamptz,
  geotab_lat             double precision,
  geotab_lng             double precision,
  geotab_captured_at     timestamptz,
  geotab_distance_meters integer,
  notes                  text not null default '',
  photos                 text[] not null default '{}',
  flagged                boolean not null default false
);
create index vehicle_inspections_driver_idx on vehicle_inspections (driver_id);
create index vehicle_inspections_vehicle_idx on vehicle_inspections (vehicle_id);
alter table vehicle_inspections enable row level security;

create table inspection_items (
  id            uuid primary key default gen_random_uuid(),
  inspection_id text not null references vehicle_inspections (id) on delete cascade,
  name          text not null,
  status        inspection_item_status not null,
  notes         text not null default ''
);
create index inspection_items_inspection_idx on inspection_items (inspection_id);
alter table inspection_items enable row level security;

-- -----------------------------------------------------------------------------
-- ticket_transactions + ticket_replenishments (prepaid dump tickets)
-- -----------------------------------------------------------------------------
create table ticket_transactions (
  id            text primary key,
  client_id     text not null references clients (id) on delete cascade,
  kind          ticket_txn_kind not null,
  qty           integer not null,
  balance_after integer not null,
  occurred_at   timestamptz not null default now(),
  work_order_id text references work_orders (id) on delete set null,
  vehicle_id    text references vehicles (id) on delete set null,
  dump_site     text,
  reason        text not null default ''
);
create index ticket_transactions_client_idx on ticket_transactions (client_id);
create index ticket_transactions_occurred_idx on ticket_transactions (occurred_at desc);
alter table ticket_transactions enable row level security;

create table ticket_replenishments (
  id              text primary key,
  client_id       text not null references clients (id) on delete cascade,
  invoice_data_id text not null references invoice_data (id),
  qty             integer not null,
  amount          numeric(10,2) not null,
  triggered_at    timestamptz not null default now(),
  auto_billed     boolean not null default false,
  qbo_sync_status qbo_sync_status not null default 'pending',
  qbo_invoice_id  text
);
create index ticket_replenishments_client_idx on ticket_replenishments (client_id);
alter table ticket_replenishments enable row level security;

-- -----------------------------------------------------------------------------
-- Auth trigger: when a new auth.users row appears, mirror into profiles.
-- Default role is 'driver'; admins promote via SQL or admin UI.
-- -----------------------------------------------------------------------------
create or replace function handle_new_auth_user() returns trigger
  language plpgsql security definer set search_path = public
as $$
begin
  insert into profiles (id, email, name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    coalesce((new.raw_user_meta_data->>'role')::user_role, 'driver')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_auth_user();
