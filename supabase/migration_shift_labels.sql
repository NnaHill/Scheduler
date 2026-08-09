-- Custom shift display names, per manager. Purely cosmetic — the
-- underlying shift codes (E1-E9) stay exactly as they are everywhere
-- else (algorithm, colors, continuity rules); this only controls what
-- gets shown on screen instead of the raw code. Missing a row for a
-- code just means "show the code itself" (the default).
--
-- Brand-new table, so this gets its real (restrictive) security policy
-- from the very start — no staged rollout needed like the other tables.
create table if not exists shift_labels (
  owner_id uuid not null references auth.users(id),
  code text not null,
  label text not null check (char_length(label) <= 4),
  primary key (owner_id, code)
);
alter table shift_labels enable row level security;
create policy "owner or admin" on shift_labels for all
  using (owner_id = auth.uid() or is_admin())
  with check (owner_id = auth.uid() or is_admin());
