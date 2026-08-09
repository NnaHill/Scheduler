-- STEP 2, PART 1 of 3 — safe to run immediately.
-- This only ADDS things (a new table, a trigger, and some new columns).
-- It does NOT touch your existing "anon full access" policies, so
-- nothing about how the app currently works changes yet.

-- One row per login (per Supabase Auth user). Role decides whether
-- someone is a shift manager (sees only their own data) or the admin
-- (sees/edits everyone's). Every new login automatically gets a row
-- here via the trigger below, defaulting to 'manager' — you promote
-- your own account to 'admin' with one command after creating it
-- (given to you in part 2).
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'manager' check (role in ('admin', 'manager')),
  name text
);
alter table profiles enable row level security;

-- security definer = this function's own internal query ignores RLS,
-- which avoids an infinite loop that would otherwise happen from a
-- policy on `profiles` needing to query `profiles` to check the role.
create or replace function is_admin() returns boolean
language sql security definer stable
as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

create policy "read own or admin reads all" on profiles for select using (id = auth.uid() or is_admin());
create policy "update own name or admin updates any" on profiles for update
  using (id = auth.uid() or is_admin())
  with check (is_admin() or (id = auth.uid())); -- a non-admin can't hand themselves the admin role
create policy "admin manages profiles" on profiles for insert with check (is_admin());
create policy "admin deletes profiles" on profiles for delete using (is_admin());

-- Every Supabase Auth login (however it's created — dashboard or app)
-- automatically gets a matching profiles row, defaulting to 'manager'.
create or replace function handle_new_user() returns trigger
language plpgsql security definer
as $$
begin
  insert into public.profiles (id, role, name) values (new.id, 'manager', new.email);
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

-- Which manager's data each row belongs to. Nullable for now — your
-- existing rows will get backfilled to your account in part 2, once
-- your account exists and I have your user ID.
alter table employees add column if not exists owner_id uuid references auth.users(id);
alter table holidays add column if not exists owner_id uuid references auth.users(id);
alter table collapsed_shifts add column if not exists owner_id uuid references auth.users(id);
alter table saved_schedules add column if not exists owner_id uuid references auth.users(id);

-- NOTE: holidays and collapsed_shifts currently use just the date (or
-- shift code) as their unique key. Once two managers exist, they could
-- collide (two managers both marking Christmas as a holiday, say) — a
-- later step widens their uniqueness to (owner_id, date/code) instead,
-- once owner_id is actually populated. Nothing to do here yet.
