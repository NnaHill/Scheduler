-- PART 2 of 2 — run ONLY after the app is confirmed working against
-- shift_definitions. Removes the two tables it replaces. Their data
-- has already been copied into shift_definitions by part 1 — this is
-- the actual destructive step, so it's kept separate and last on
-- purpose.

drop table if exists collapsed_shifts;
drop table if exists shift_labels;
