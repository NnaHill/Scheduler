-- PRN staff's weekly availability pattern — "generally available on these
-- days of the week" (0=Sun..6=Sat), used only to bulk-fill the per-day
-- availability grid via "Apply availability pattern". It is NOT read by
-- the scheduler itself; the grid (extra_availability) stays the single
-- source of truth for who's actually eligible on a given day, same as
-- before this migration.
alter table employees add column if not exists available_days_of_week int[] not null default '{}';
