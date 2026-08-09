-- PART 1 of 2 — safe to run now, purely additive.
-- Creates one consolidated table replacing three previously separate
-- things: the hardcoded shift list, the "collapsed_shifts" table, and
-- the "shift_labels" table from Step 3. Each manager now has one row
-- per shift they've defined, holding everything about it: its name,
-- whether it's temporarily paused, whether it needs continuity rules,
-- and how many days in a row if so.
--
-- This does NOT touch collapsed_shifts or shift_labels yet — it copies
-- their data into the new table, leaving the old ones untouched, so
-- there's a safe rollback point before anything old gets removed
-- (that happens in part 2, only after the app is confirmed working).

create table if not exists shift_definitions (
  owner_id uuid not null references auth.users(id),
  code text not null,
  label text,
  sort_order int not null default 0,
  active_weekend boolean not null default false,
  collapsed boolean not null default false,
  continuity_min int,
  continuity_max int,
  primary key (owner_id, code),
  check (label is null or char_length(label) <= 4),
  check ((continuity_min is null) = (continuity_max is null)),
  check (continuity_min is null or (continuity_min >= 1 and continuity_max >= continuity_min))
);
alter table shift_definitions enable row level security;
create policy "owner or admin" on shift_definitions for all
  using (owner_id = auth.uid() or is_admin())
  with check (owner_id = auth.uid() or is_admin());

-- Seed today's exact default (E1-E9, E1/E2/E3/E4/E8 on weekends, E7
-- needing 2-3 consecutive days) for every account that already has
-- employees — this is everyone using the app today, so nothing about
-- their current schedule changes. Any brand-new manager going forward
-- gets this same starting point automatically from the app itself, the
-- same way their employee roster starts (from the app's own default,
-- not from this one-time migration).
insert into shift_definitions (owner_id, code, sort_order, active_weekend, continuity_min, continuity_max)
select distinct e.owner_id, code_data.code, code_data.sort_order, code_data.active_weekend, code_data.continuity_min, code_data.continuity_max
from employees e
cross join (values
  ('E1', 0, true, null, null),
  ('E2', 1, false, null, null),
  ('E3', 2, false, null, null),
  ('E4', 3, true, null, null),
  ('E5', 4, false, null, null),
  ('E6', 5, false, null, null),
  ('E7', 6, false, 2, 3),
  ('E8', 7, true, null, null),
  ('E9', 8, false, null, null)
) as code_data(code, sort_order, active_weekend, continuity_min, continuity_max)
on conflict (owner_id, code) do nothing;

-- Carry over anything already customized: paused shifts...
update shift_definitions sd
set collapsed = true
from collapsed_shifts cs
where cs.owner_id = sd.owner_id and cs.code = sd.code;

-- ...and custom names.
update shift_definitions sd
set label = sl.label
from shift_labels sl
where sl.owner_id = sd.owner_id and sl.code = sd.code;
