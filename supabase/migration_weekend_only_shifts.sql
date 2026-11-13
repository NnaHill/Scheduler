-- A shift marked weekend-only never shows up Monday-Friday, only on
-- Saturday/Sunday (and holidays, same "weekend" bucket the app already
-- uses everywhere else). Independent of active_weekend: a weekend-only
-- shift counts as weekend-active automatically, no need to also tick that
-- box.
alter table shift_definitions add column if not exists weekend_only boolean not null default false;
