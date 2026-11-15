-- Two named "save slots" per manager, separate from saved_schedules (which
-- always holds whatever's currently on screen, including manual edits, and
-- gets silently overwritten on every generate/edit). A slot only changes
-- when the manager explicitly clicks "Save" — a snapshot of a schedule
-- they want to keep around to compare against or fall back to later,
-- independent of whatever they regenerate next. Clicking a saved slot
-- loads its snapshot back as the active schedule.
create table if not exists schedule_save_slots (
  owner_id uuid not null references auth.users(id),
  slot smallint not null check (slot in (1, 2)),
  snapshot jsonb not null,
  saved_at timestamptz not null default now(),
  primary key (owner_id, slot)
);
alter table schedule_save_slots enable row level security;
create policy "owner or admin" on schedule_save_slots for all
  using (owner_id = auth.uid() or is_admin())
  with check (owner_id = auth.uid() or is_admin());
