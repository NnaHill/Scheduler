-- STEP 2, PART 2 of 3 — assigns your existing data to your account.
-- Safe to run now. Only fills in the empty owner_id you already saw as
-- null — no rows get deleted or changed in any other way.

update employees set owner_id = '27591291-7d11-4499-8a16-8f46d6c9608e' where owner_id is null;
update holidays set owner_id = '27591291-7d11-4499-8a16-8f46d6c9608e' where owner_id is null;
update collapsed_shifts set owner_id = '27591291-7d11-4499-8a16-8f46d6c9608e' where owner_id is null;
update saved_schedules set owner_id = '27591291-7d11-4499-8a16-8f46d6c9608e' where owner_id is null;

-- Now that every row has an owner, require it going forward.
alter table employees alter column owner_id set not null;
alter table holidays alter column owner_id set not null;
alter table collapsed_shifts alter column owner_id set not null;
alter table saved_schedules alter column owner_id set not null;

-- Widen holidays/collapsed_shifts so two different managers can each
-- have their own version of the same date or shift code without
-- colliding (previously the date/code alone had to be unique across
-- EVERYONE; now it only has to be unique per manager). This will also
-- trigger Supabase's "destructive operations" warning (it sees DROP)
-- — same story as before: no rows are removed, this only replaces
-- which combination of columns has to be unique.
alter table holidays drop constraint if exists holidays_pkey;
alter table holidays add primary key (owner_id, day_iso);

alter table collapsed_shifts drop constraint if exists collapsed_shifts_pkey;
alter table collapsed_shifts add primary key (owner_id, code);
