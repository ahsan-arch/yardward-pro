-- =============================================================================
-- Seed the first admin user so the team can sign into the freshly-migrated CRM.
-- Idempotent: skips if the email is already present in auth.users.
--
-- Login:    admin@yardward.pro
-- Password: ChangeMe!2026
--
-- The handle_new_auth_user trigger from initial_schema.sql will mirror this row
-- into public.profiles, picking up role='admin' from raw_user_meta_data.
-- =============================================================================

do $$
declare
  v_user_id uuid;
begin
  select id into v_user_id from auth.users where email = 'admin@yardward.pro';
  if v_user_id is not null then
    raise notice 'Admin user already exists, skipping seed.';
    return;
  end if;

  insert into auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at,
    confirmation_token,
    email_change,
    email_change_token_new,
    recovery_token
  ) values (
    '00000000-0000-0000-0000-000000000000',
    gen_random_uuid(),
    'authenticated',
    'authenticated',
    'admin@yardward.pro',
    crypt('ChangeMe!2026', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"name":"Yardward Admin","role":"admin"}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    ''
  );
end
$$;
