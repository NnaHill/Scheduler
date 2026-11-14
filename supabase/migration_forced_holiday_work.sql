-- "Force holiday work" tags — the opposite of PTO: a specific employee
-- MUST be scheduled a real shift on a specific date (typically a sparse-
-- coverage holiday), overriding their normal day off, fixed-day pattern,
-- or weekend rotation for that one day. Existence of a row = forced;
-- there's no status/source column because unlike pto_status this has
-- only one kind of entry.
create table if not exists forced_holiday_work (
  owner_id uuid not null references auth.users(id),
  employee_id bigint not null references employees(id) on delete cascade,
  day_iso date not null,
  primary key (employee_id, day_iso)
);
alter table forced_holiday_work enable row level security;
create policy "owner or admin" on forced_holiday_work for all
  using (owner_id = auth.uid() or is_admin())
  with check (owner_id = auth.uid() or is_admin());
