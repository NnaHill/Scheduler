-- Optional custom display name for a save slot (e.g. "Before holidays"),
-- shown instead of the generic "Slot 1"/"Slot 2" label. Null keeps the
-- default label.
alter table schedule_save_slots add column if not exists name text;
