-- Adds the shift-cap column for employees on compressed/extended-hour
-- schedules (e.g. 7 shifts per 14 days at >8hr/shift instead of the
-- standard cadence). Run once in the Supabase SQL Editor.
alter table employees add column if not exists shift_cap jsonb;
