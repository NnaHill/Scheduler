import { supabase } from "./supabase";

// Every read is scoped to `ownerId` explicitly, not left to RLS alone.
// For a regular manager this is redundant with what RLS would already
// filter to — harmless. For the admin (whose RLS allows seeing every
// manager's rows) it's the difference between "viewing one manager's
// roster" and "seeing everyone's employees mashed into one table" —
// RLS only decides what you're ALLOWED to see, not which slice of that
// you're currently looking at. Every write stamps `owner_id` the same
// way, since nothing else will fill it in for a new row.

const employeeFromRow = (r) => ({
  id: r.id,
  name: r.name,
  type: r.type,
  fixedDays: r.fixed_days || [],
  allowedShifts: r.allowed_shifts || [],
  shiftCap: r.shift_cap || null,
  weekendRotation: r.weekend_rotation || null,
});
const employeeToRow = (e, ownerId) => ({
  id: e.id,
  name: e.name,
  type: e.type,
  fixed_days: e.fixedDays,
  allowed_shifts: e.allowedShifts,
  shift_cap: e.shiftCap || null,
  weekend_rotation: e.weekendRotation || null,
  owner_id: ownerId,
});

export async function fetchEmployees(ownerId) {
  const { data, error } = await supabase.from("employees").select("*").eq("owner_id", ownerId).order("id");
  if (error) throw error;
  return data.map(employeeFromRow);
}
// For a brand-new employee. The database assigns the ID (it's the only
// thing that can guarantee uniqueness across every manager's roster
// combined) — the row you pass in is missing `id`, and the one that
// comes back has the real one, which the caller then uses for local
// state instead of guessing.
export async function insertEmployee(employee, ownerId) {
  const { id, ...rowWithoutId } = employeeToRow(employee, ownerId);
  const { data, error } = await supabase.from("employees").insert(rowWithoutId).select().single();
  if (error) throw error;
  return employeeFromRow(data);
}
// For an employee whose ID is already known (an edit, not a new hire).
// A plain UPDATE, not an upsert — `id` is GENERATED ALWAYS AS IDENTITY,
// so any INSERT (which is what upsert compiles to under the hood, even
// when it resolves to a conflict) that includes an explicit id value is
// rejected by Postgres outright.
export async function upsertEmployee(employee, ownerId) {
  const { id, ...rowWithoutId } = employeeToRow(employee, ownerId);
  const { error } = await supabase.from("employees").update(rowWithoutId).eq("id", id).eq("owner_id", ownerId);
  if (error) throw error;
}
export async function deleteEmployee(id, ownerId) {
  const { error } = await supabase.from("employees").delete().eq("id", id).eq("owner_id", ownerId);
  if (error) throw error;
}

export async function fetchHolidays(ownerId) {
  const { data, error } = await supabase.from("holidays").select("day_iso").eq("owner_id", ownerId);
  if (error) throw error;
  return data.map((r) => r.day_iso);
}
export async function addHolidayRow(iso, ownerId) {
  const { error } = await supabase.from("holidays").upsert({ day_iso: iso, owner_id: ownerId }, { onConflict: "owner_id,day_iso" });
  if (error) throw error;
}
export async function removeHolidayRow(iso, ownerId) {
  const { error } = await supabase.from("holidays").delete().eq("day_iso", iso).eq("owner_id", ownerId);
  if (error) throw error;
}

// Each manager's own shift roster — replaces what used to be a single
// hardcoded list shared by everyone, plus the separate collapsed_shifts
// and shift_labels tables (one row per shift now holds all of that:
// name, paused/active, and continuity rule if any).
const shiftDefFromRow = (r) => ({
  code: r.code,
  label: r.label || null,
  sortOrder: r.sort_order,
  activeWeekend: r.active_weekend,
  collapsed: r.collapsed,
  continuityMin: r.continuity_min,
  continuityMax: r.continuity_max,
});
const shiftDefToRow = (d, ownerId) => ({
  owner_id: ownerId,
  code: d.code,
  label: d.label || null,
  sort_order: d.sortOrder,
  active_weekend: d.activeWeekend,
  collapsed: d.collapsed,
  continuity_min: d.continuityMin ?? null,
  continuity_max: d.continuityMax ?? null,
});

export async function fetchShiftDefinitions(ownerId) {
  const { data, error } = await supabase.from("shift_definitions").select("*").eq("owner_id", ownerId).order("sort_order");
  if (error) throw error;
  return data.map(shiftDefFromRow);
}
// Bulk-create — used once, to seed a brand-new manager's default roster.
export async function insertShiftDefinitions(defs, ownerId) {
  if (defs.length === 0) return;
  const { error } = await supabase.from("shift_definitions").insert(defs.map((d) => shiftDefToRow(d, ownerId)));
  if (error) throw error;
}
// Covers both a brand-new shift (Add) and editing an existing one
// (rename, toggle weekend/paused, set or clear continuity).
export async function upsertShiftDefinition(def, ownerId) {
  const { error } = await supabase.from("shift_definitions").upsert(shiftDefToRow(def, ownerId), { onConflict: "owner_id,code" });
  if (error) throw error;
}
export async function deleteShiftDefinition(code, ownerId) {
  const { error } = await supabase.from("shift_definitions").delete().eq("code", code).eq("owner_id", ownerId);
  if (error) throw error;
}

export async function fetchPtoStatus(startIso, endIso, ownerId) {
  const { data, error } = await supabase
    .from("pto_status")
    .select("employee_id, day_iso, status, source")
    .eq("owner_id", ownerId)
    .gte("day_iso", startIso)
    .lte("day_iso", endIso);
  if (error) throw error;
  return data;
}
export async function upsertPtoStatus(employeeId, iso, status, source, ownerId) {
  const { error } = await supabase
    .from("pto_status")
    .upsert({ employee_id: employeeId, day_iso: iso, status, source: source || "manual", owner_id: ownerId }, { onConflict: "employee_id,day_iso" });
  if (error) throw error;
}
export async function bulkUpsertPtoStatus(rows) {
  if (rows.length === 0) return;
  const { error } = await supabase.from("pto_status").upsert(rows, { onConflict: "employee_id,day_iso" });
  if (error) throw error;
}
export async function bulkDeletePtoStatus(employeeId, startIso, endIso, ownerId) {
  const { error } = await supabase
    .from("pto_status")
    .delete()
    .eq("employee_id", employeeId)
    .eq("owner_id", ownerId)
    .gte("day_iso", startIso)
    .lte("day_iso", endIso);
  if (error) throw error;
}
// Clears specific dates for one employee, but ONLY rows tagged with the
// given source — e.g. re-applying a weekend rotation can safely remove
// its own previously auto-generated PTO-1 entries (say, after the
// employee's rotation group changed) without ever touching a manual
// entry, even one sitting on the same date.
export async function clearPtoStatusForDates(employeeId, isoList, source, ownerId) {
  if (isoList.length === 0) return;
  const { error } = await supabase
    .from("pto_status")
    .delete()
    .eq("employee_id", employeeId)
    .eq("owner_id", ownerId)
    .eq("source", source)
    .in("day_iso", isoList);
  if (error) throw error;
}
export async function deletePtoStatus(employeeId, iso, ownerId) {
  const { error } = await supabase
    .from("pto_status")
    .delete()
    .eq("employee_id", employeeId)
    .eq("owner_id", ownerId)
    .eq("day_iso", iso);
  if (error) throw error;
}

export async function fetchExtraAvailability(startIso, endIso, ownerId) {
  const { data, error } = await supabase
    .from("extra_availability")
    .select("employee_id, day_iso")
    .eq("owner_id", ownerId)
    .gte("day_iso", startIso)
    .lte("day_iso", endIso);
  if (error) throw error;
  return data;
}
export async function addExtraAvailabilityRow(employeeId, iso, ownerId) {
  const { error } = await supabase
    .from("extra_availability")
    .upsert({ employee_id: employeeId, day_iso: iso, owner_id: ownerId }, { onConflict: "employee_id,day_iso" });
  if (error) throw error;
}
export async function removeExtraAvailabilityRow(employeeId, iso, ownerId) {
  const { error } = await supabase
    .from("extra_availability")
    .delete()
    .eq("employee_id", employeeId)
    .eq("owner_id", ownerId)
    .eq("day_iso", iso);
  if (error) throw error;
}

export async function saveScheduleSnapshot(snapshot, ownerId) {
  const { error } = await supabase.from("saved_schedules").insert({ snapshot, owner_id: ownerId });
  if (error) throw error;
}
