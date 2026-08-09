-- STEP 2, PART 3 of 3 — THE SWITCH.
-- Everything before this was preparation. This is the step that
-- actually makes each manager's data private: before this, every
-- table was wide open to anyone with the app's public key. After this,
-- a manager can only see/edit their own data, and you (admin) can see
-- and edit everyone's.
--
-- You'll get the "destructive operations" warning again — same story,
-- it sees DROP POLICY and flags it generically. No rows are touched by
-- this at all; only who's allowed to see them changes.

drop policy if exists "anon full access" on employees;
drop policy if exists "anon full access" on holidays;
drop policy if exists "anon full access" on collapsed_shifts;
drop policy if exists "anon full access" on saved_schedules;
drop policy if exists "anon full access" on pto_status;
drop policy if exists "anon full access" on extra_availability;

create policy "owner or admin" on employees for all using (owner_id = auth.uid() or is_admin()) with check (owner_id = auth.uid() or is_admin());
create policy "owner or admin" on holidays for all using (owner_id = auth.uid() or is_admin()) with check (owner_id = auth.uid() or is_admin());
create policy "owner or admin" on collapsed_shifts for all using (owner_id = auth.uid() or is_admin()) with check (owner_id = auth.uid() or is_admin());
create policy "owner or admin" on saved_schedules for all using (owner_id = auth.uid() or is_admin()) with check (owner_id = auth.uid() or is_admin());
create policy "owner or admin" on pto_status for all using (owner_id = auth.uid() or is_admin()) with check (owner_id = auth.uid() or is_admin());
create policy "owner or admin" on extra_availability for all using (owner_id = auth.uid() or is_admin()) with check (owner_id = auth.uid() or is_admin());
