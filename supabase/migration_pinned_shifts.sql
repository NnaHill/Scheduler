-- Manual shift pins — a manager hand-writes a SPECIFIC shift code for a
-- specific employee on a specific date (e.g. "Reyna works E3 on 12/25
-- because we already promised her that"), and the generator locks it
-- in before building the rest of the schedule around it, the same way
-- continuity, weekend pairing, and forced holiday work already do.
-- Unlike forced holiday work (which only tags the day and lets the
-- generator pick a trained, active code), this stores the exact code
-- the manager chose.
create table if not exists pinned_shifts (
  owner_id uuid not null references auth.users(id),
  employee_id bigint not null references employees(id) on delete cascade,
  day_iso date not null,
  code text not null,
  primary key (employee_id, day_iso)
);
alter table pinned_shifts enable row level security;
create policy "owner or admin" on pinned_shifts for all
  using (owner_id = auth.uid() or is_admin())
  with check (owner_id = auth.uid() or is_admin());
