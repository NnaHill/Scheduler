-- Marks the one reserved "overflow" shift (code E0) that exists purely to
-- top up an extended-hour employee's guaranteed shift count — the only
-- shift code that can have more than one person on it the same day.
alter table shift_definitions add column if not exists overflow boolean not null default false;
