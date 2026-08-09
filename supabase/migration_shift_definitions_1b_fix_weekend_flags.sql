-- Corrects a copy-paste error in the previous migration: E2 and E3
-- should be marked active on weekends/holidays (matching the original
-- default set of E1, E2, E3, E4, E8) but were written as false. This
-- fixes it for every account the buggy migration touched.
update shift_definitions set active_weekend = true where code in ('E2', 'E3');
