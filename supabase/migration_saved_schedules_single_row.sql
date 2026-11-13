-- saved_schedules currently gets a new row every time a schedule is
-- generated or manually edited, and nothing reads any of it back --
-- confirmed nothing in the app selects from this table today, so
-- clearing it out first is safe and loses nothing. From here on, saving
-- overwrites one row per manager instead of piling up a new one, and the
-- app reads that row back on login to restore your last schedule.
truncate table saved_schedules;
alter table saved_schedules add constraint saved_schedules_owner_id_key unique (owner_id);
