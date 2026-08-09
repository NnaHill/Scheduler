-- STEP 2, PART 2b — the piece I missed. Adds the same "who owns this
-- row" tracking to pto_status and extra_availability that the other
-- four tables already got. Safe to run now — additive + backfill only,
-- same pattern as before, no security changes yet.

alter table pto_status add column if not exists owner_id uuid references auth.users(id);
alter table extra_availability add column if not exists owner_id uuid references auth.users(id);

-- Backfill by inheriting ownership from the employee each row already
-- belongs to (via employee_id), rather than hardcoding your ID again —
-- this stays correct even later, once more than one manager exists.
update pto_status ps set owner_id = e.owner_id from employees e where e.id = ps.employee_id and ps.owner_id is null;
update extra_availability ea set owner_id = e.owner_id from employees e where e.id = ea.employee_id and ea.owner_id is null;

alter table pto_status alter column owner_id set not null;
alter table extra_availability alter column owner_id set not null;
