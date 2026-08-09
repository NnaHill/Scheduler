-- STEP 2, PART 4 — fixes a real bug the test manager account just
-- caught: employee IDs were computed in the browser as "1 more than
-- the highest ID I can currently see." That was fine when everyone
-- shared one list, but now each manager only sees their own employees
-- — so a brand-new manager always computes "1", which can collide with
-- an ID another manager already has (it did: the test manager's first
-- employee tried to become ID 1, which is already Cecilia).
--
-- Fix: let the database hand out IDs instead of guessing them in the
-- browser. This safely continues counting from whatever your highest
-- existing ID currently is, so nothing already saved is affected.

do $$
declare
  next_id bigint;
begin
  select coalesce(max(id), 0) + 1 into next_id from employees;
  alter table employees alter column id add generated always as identity;
  execute format('alter table employees alter column id restart with %s', next_id);
end $$;
