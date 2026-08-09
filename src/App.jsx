import React, { useState, useMemo, useEffect } from "react";
import {
  fetchEmployees,
  insertEmployee,
  upsertEmployee,
  deleteEmployee,
  fetchHolidays,
  addHolidayRow,
  removeHolidayRow,
  fetchPtoStatus,
  upsertPtoStatus,
  deletePtoStatus,
  bulkUpsertPtoStatus,
  bulkDeletePtoStatus,
  clearPtoStatusForDates,
  fetchExtraAvailability,
  addExtraAvailabilityRow,
  removeExtraAvailabilityRow,
  saveScheduleSnapshot,
  fetchShiftDefinitions,
  insertShiftDefinitions,
  upsertShiftDefinition,
  deleteShiftDefinition,
} from "./lib/persistence";
import {
  toLocalISO, nextMonday, fmtLabel, key, shiftPref,
  wouldExceedShiftCap, workedDayIndicesFromSchedule, respectsFixedDayRestriction,
  weekendIndexFor, isOpenWeekend, kuhnMatch, partitionRun,
  longestConsecutiveRun, wouldExceedConsecutiveDays,
} from "./lib/schedulingCore";
import { buildFeasibilityReport } from "./lib/feasibility";
import { downloadScheduleCsv } from "./lib/csvExport";
import { fetchAllProfiles } from "./lib/auth";
import AccountSettings from "./AccountSettings";

// Every manager has their own shift roster now (stored in
// shift_definitions, fetched per-account) — this is only the starting
// point handed to a brand-new manager the first time they log in,
// matching the app's original shift set exactly. From then on, that
// manager's own rows in the database are the only source of truth;
// editing this array doesn't affect anyone who's already been seeded.
const DEFAULT_SHIFT_DEFINITIONS = [
  { code: "E1", label: null, sortOrder: 0, activeWeekend: true, collapsed: false, continuityMin: null, continuityMax: null },
  { code: "E2", label: null, sortOrder: 1, activeWeekend: true, collapsed: false, continuityMin: null, continuityMax: null },
  { code: "E3", label: null, sortOrder: 2, activeWeekend: true, collapsed: false, continuityMin: null, continuityMax: null },
  { code: "E4", label: null, sortOrder: 3, activeWeekend: true, collapsed: false, continuityMin: null, continuityMax: null },
  { code: "E5", label: null, sortOrder: 4, activeWeekend: false, collapsed: false, continuityMin: null, continuityMax: null },
  { code: "E6", label: null, sortOrder: 5, activeWeekend: false, collapsed: false, continuityMin: null, continuityMax: null },
  { code: "E7", label: null, sortOrder: 6, activeWeekend: false, collapsed: false, continuityMin: 2, continuityMax: 3 },
  { code: "E8", label: null, sortOrder: 7, activeWeekend: true, collapsed: false, continuityMin: null, continuityMax: null },
  { code: "E9", label: null, sortOrder: 8, activeWeekend: false, collapsed: false, continuityMin: null, continuityMax: null },
];
// Default palette for the original E1-E9 codes, purely cosmetic. Any
// other code (E10+, or a renamed/custom one) falls back to the
// hash-based color below instead — distinct and consistent, just not
// hand-picked.
const DEFAULT_SHIFT_COLORS = {
  E1: "#2563EB", E2: "#7C3AED", E3: "#DB2777", E4: "#DC2626", E5: "#EA580C",
  E6: "#CA8A04", E7: "#65A30D", E8: "#0D9488", E9: "#0891B2",
};
function getShiftColor(code) {
  if (DEFAULT_SHIFT_COLORS[code]) return DEFAULT_SHIFT_COLORS[code];
  let hash = 0;
  for (let i = 0; i < code.length; i++) hash = code.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${Math.abs(hash) % 360}, 65%, 45%)`;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function ShiftFairnessSchedulerV4({ session, profile: initialProfile, onSignOut }) {
  const [profile, setProfile] = useState(initialProfile);
  const [showAccountSettings, setShowAccountSettings] = useState(false);
  const [numWeeks, setNumWeeks] = useState(8);
  const [startDate, setStartDate] = useState(nextMonday());
  const [maxConsecutiveDays, setMaxConsecutiveDays] = useState(6);
  const [consecutiveHardLimit, setConsecutiveHardLimit] = useState(false);
  const [employees, setEmployees] = useState([]);
  const [ptoStatus, setPtoStatus] = useState({});
  const [ptoSource, setPtoSource] = useState({}); // key -> 'manual' | 'weekend_rotation'
  const [extraAvailable, setExtraAvailable] = useState({});
  const [holidays, setHolidays] = useState(new Set());
  const [holidayInput, setHolidayInput] = useState("");
  const [shiftDefinitions, setShiftDefinitions] = useState([]); // this manager's own shift roster
  const [newExtraName, setNewExtraName] = useState("");
  const [newExtraShifts, setNewExtraShifts] = useState([]);
  const [newPermanentName, setNewPermanentName] = useState("");
  const [schedule, setSchedule] = useState(null);
  const [tab, setTab] = useState("instructions");
  const [generating, setGenerating] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [syncError, setSyncError] = useState(null);
  const [leaveStart, setLeaveStart] = useState("");
  const [leaveEnd, setLeaveEnd] = useState("");
  // Whose data is currently loaded/edited. Defaults to (and, for a
  // regular manager, always stays) your own account. An admin can
  // switch this to a specific manager's ID to view and edit their
  // roster instead — everything reads/writes through this one value
  // so that switch only has to happen in one place.
  const [viewingOwnerId, setViewingOwnerId] = useState(session.user.id);
  const [allProfiles, setAllProfiles] = useState([]);
  const reportSyncError = (err) => { console.error(err); setSyncError(err.message || String(err)); };

  // Admin-only: the list of every account, to power the "viewing as"
  // switcher. RLS means this silently returns just your own row if
  // you're not actually an admin, so it's safe to always attempt.
  useEffect(() => {
    if (profile.role !== "admin") return;
    let cancelled = false;
    fetchAllProfiles().then((rows) => { if (!cancelled) setAllProfiles(rows); }).catch(reportSyncError);
    return () => { cancelled = true; };
  }, [profile.role]);

  const switchViewingOwner = (id) => {
    if (id === viewingOwnerId) return;
    setViewingOwnerId(id);
    setSchedule(null);
    setTab("setup");
  };

  // Initial load: employees, holidays, and collapsed shifts from Supabase.
  // A brand-new project starts with an empty roster — no assumed team
  // size — you build it via "Add employee" in the Permanent Staff tab.
  useEffect(() => {
    setLoaded(false);
    let cancelled = false;
    (async () => {
      try {
        const [emp, hol, defs] = await Promise.all([
          fetchEmployees(viewingOwnerId), fetchHolidays(viewingOwnerId), fetchShiftDefinitions(viewingOwnerId),
        ]);
        let finalDefs = defs;
        if (defs.length === 0) {
          // Brand-new manager — hand them today's default shift set to
          // start from, same as the original app always had.
          finalDefs = DEFAULT_SHIFT_DEFINITIONS;
          await insertShiftDefinitions(finalDefs, viewingOwnerId);
        }
        if (cancelled) return;
        setEmployees(emp);
        setHolidays(new Set(hol));
        setShiftDefinitions(finalDefs);
      } catch (err) {
        if (!cancelled) reportSyncError(err);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [viewingOwnerId]);

  const days = useMemo(() => {
    const start = new Date(startDate + "T00:00:00");
    return Array.from({ length: numWeeks * 7 }, (_, idx) => {
      const date = new Date(start);
      date.setDate(start.getDate() + idx);
      const dow = date.getDay();
      return { idx, date, iso: toLocalISO(date), ...fmtLabel(date), isWeekend: dow === 0 || dow === 6, dow };
    });
  }, [numWeeks, startDate]);

  // PTO and extra-staff availability are persisted keyed by absolute
  // ISO date, independent of rotation length/start date. Re-derive the
  // idx-keyed local maps the algorithm uses whenever the visible date
  // range changes.
  useEffect(() => {
    if (!loaded || days.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const startIso = days[0].iso;
        const endIso = days[days.length - 1].iso;
        const isoToIdx = new Map(days.map((d) => [d.iso, d.idx]));
        const [ptoRows, availRows] = await Promise.all([fetchPtoStatus(startIso, endIso, viewingOwnerId), fetchExtraAvailability(startIso, endIso, viewingOwnerId)]);
        if (cancelled) return;
        const nextPto = {};
        const nextPtoSource = {};
        ptoRows.forEach((r) => {
          const idx = isoToIdx.get(r.day_iso);
          if (idx === undefined) return;
          nextPto[key(r.employee_id, idx)] = r.status;
          nextPtoSource[key(r.employee_id, idx)] = r.source;
        });
        const nextAvail = {};
        availRows.forEach((r) => { const idx = isoToIdx.get(r.day_iso); if (idx !== undefined) nextAvail[key(r.employee_id, idx)] = true; });
        setPtoStatus(nextPto);
        setPtoSource(nextPtoSource);
        setExtraAvailable(nextAvail);
      } catch (err) {
        if (!cancelled) reportSyncError(err);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, startDate, numWeeks, viewingOwnerId]);

  // Everything shift-related is derived from this manager's own
  // shift_definitions rows — replaces what used to be one hardcoded
  // list shared by every manager. sortOrder keeps E1, E2, E3... in the
  // order they were set up (or however a manager's reordered them).
  const shiftDefsSorted = [...shiftDefinitions].sort((a, b) => a.sortOrder - b.sortOrder);
  const shiftDefByCode = Object.fromEntries(shiftDefsSorted.map((d) => [d.code, d]));
  const ALL_SHIFT_CODES = shiftDefsSorted.map((d) => d.code);
  const continuityRules = Object.fromEntries(
    shiftDefsSorted.filter((d) => d.continuityMin != null).map((d) => [d.code, { minDays: d.continuityMin, maxDays: d.continuityMax }])
  );
  const isContinuityCode = (code) => shiftDefByCode[code]?.continuityMin != null;
  const shiftLabel = (code) => shiftDefByCode[code]?.label || code;
  // The compact schedule grid cells are a fixed, tiny size — a 4-char
  // custom label needs a smaller font than the default 2-char codes to
  // avoid overflowing, so this scales down as the label gets longer.
  const gridCellFontSize = (label) => (label.length <= 2 ? "9px" : label.length === 3 ? "8px" : "7px");
  const weekdayShifts = ALL_SHIFT_CODES.filter((s) => !shiftDefByCode[s].collapsed);
  const weekendShifts = ALL_SHIFT_CODES.filter((s) => shiftDefByCode[s].activeWeekend && !shiftDefByCode[s].collapsed);
  const permanent = employees.filter((e) => e.type === "permanent");
  const extra = employees.filter((e) => e.type === "extra");

  // Pre-generation capacity estimate — recomputed live as PTO, rotation
  // settings, or the visible date range change, so shortfalls are
  // visible before spending a click on Generate. See feasibility.js for
  // exactly what this can and can't guarantee.
  const feasibility = useMemo(
    () => buildFeasibilityReport({ days, permanent, extra, ptoStatus, extraAvailable, weekdayShifts, weekendShifts, holidays }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [days, employees, ptoStatus, extraAvailable, weekdayShifts, weekendShifts, holidays]
  );

  // Shared by every shift edit below (rename, weekend toggle, pause
  // toggle, continuity on/off) — one place that updates local state and
  // saves, so each specific action is just "what changed."
  const updateShiftDefinition = (code, changes) =>
    setShiftDefinitions((prev) => {
      const next = prev.map((d) => (d.code === code ? { ...d, ...changes } : d));
      const updated = next.find((d) => d.code === code);
      upsertShiftDefinition(updated, viewingOwnerId).catch(reportSyncError);
      return next;
    });
  // Capped at 4 characters and uppercased for visual consistency with
  // the default codes (E1..E9). Clearing it back to empty removes the
  // customization — the shift just displays as its own code again.
  const renameShift = (code, rawValue) => updateShiftDefinition(code, { label: rawValue.toUpperCase().slice(0, 4) || null });
  const toggleShiftWeekend = (code) => updateShiftDefinition(code, { activeWeekend: !shiftDefByCode[code].activeWeekend });
  // Kept as "pick up to 2" — same limit the original high-turnover-mode
  // toggle always had, just now operating over each manager's own list
  // instead of a fixed shared one.
  const toggleShiftCollapse = (code) => {
    const def = shiftDefByCode[code];
    if (!def.collapsed && shiftDefinitions.filter((d) => d.collapsed).length >= 2) return;
    updateShiftDefinition(code, { collapsed: !def.collapsed });
  };
  const setShiftContinuity = (code, enabled) =>
    updateShiftDefinition(code, enabled ? { continuityMin: 2, continuityMax: 3 } : { continuityMin: null, continuityMax: null });
  const setShiftContinuityDays = (code, field, value) =>
    updateShiftDefinition(code, { [field]: Math.max(1, Number(value) || 1) });
  // New shifts are auto-named the next unused "E" number (E10, E11...)
  // so they never collide with an existing code, including ones a
  // manager renamed for display — the underlying code is still just an
  // internal identifier, never shown unless a shift has no custom name.
  const addShiftDefinition = () => {
    const nextNum = Math.max(0, ...shiftDefinitions.map((d) => Number(/^E(\d+)$/.exec(d.code)?.[1]) || 0)) + 1;
    const newDef = { code: `E${nextNum}`, label: null, sortOrder: shiftDefinitions.length, activeWeekend: false, collapsed: false, continuityMin: null, continuityMax: null };
    setShiftDefinitions((prev) => [...prev, newDef]);
    upsertShiftDefinition(newDef, viewingOwnerId).catch(reportSyncError);
  };
  const removeShiftDefinition = (code) => {
    if (!window.confirm(`Remove shift ${shiftLabel(code)}? Any employee trained on it, or past schedules using it, are unaffected — it just won't be used going forward.`)) return;
    setShiftDefinitions((prev) => prev.filter((d) => d.code !== code));
    deleteShiftDefinition(code, viewingOwnerId).catch(reportSyncError);
  };
  const toggleFixedDay = (empId, dow) =>
    setEmployees((prev) => prev.map((e) => {
      if (e.id !== empId) return e;
      const updated = { ...e, fixedDays: e.fixedDays.includes(dow) ? e.fixedDays.filter((d) => d !== dow) : [...e.fixedDays, dow] };
      upsertEmployee(updated, viewingOwnerId).catch(reportSyncError);
      return updated;
    }));
  // Toggle/edit a rolling shift-count cap for employees on
  // compressed/extended-hour schedules. `cap` is { windowDays, maxShifts }
  // or null to remove it — the matching/optimization logic reads this
  // straight off the employee record, so no other change is needed to
  // support a 2nd, 3rd, etc. employee, or a different ratio.
  const setEmployeeShiftCap = (empId, cap) =>
    setEmployees((prev) => prev.map((e) => {
      if (e.id !== empId) return e;
      const updated = { ...e, shiftCap: cap };
      upsertEmployee(updated, viewingOwnerId).catch(reportSyncError);
      return updated;
    }));
  // Toggle/edit an employee's weekend rotation cycle. `rotation` is
  // { cycleWeekends, openOffset } or null to opt out (works every
  // weekend). Only changes the setting — call applyWeekendRotation() to
  // actually (re)generate the PTO-1 entries for the visible schedule.
  const setEmployeeWeekendRotation = (empId, rotation) =>
    setEmployees((prev) => prev.map((e) => {
      if (e.id !== empId) return e;
      const updated = { ...e, weekendRotation: rotation };
      upsertEmployee(updated, viewingOwnerId).catch(reportSyncError);
      return updated;
    }));
  // Applies every permanent employee's weekend rotation to the CURRENTLY
  // VISIBLE Saturdays/Sundays: hard-blocks (PTO-1) the weekends their
  // cycle says they're off, leaves the rest alone. Safe to re-run any
  // time (after adding employees, changing someone's rotation group, or
  // changing the visible date range) — it only ever touches PTO-1 rows
  // IT generated before (tracked via ptoSource), so manual PTO entries,
  // including a manual edit made on top of a cell this same feature
  // auto-set earlier, are never overwritten.
  const applyWeekendRotation = () => {
    const weekendDays = days.filter((d) => d.dow === 0 || d.dow === 6);
    const toSet = []; // { empId, iso, idx }
    const toClearByEmp = new Map(); // empId -> [iso, ...]
    permanent.forEach((emp) => {
      if (!emp.weekendRotation) return;
      weekendDays.forEach((d) => {
        // A Saturday or Sunday that's already one of this employee's
        // fixed work days is a locked commitment, not a discretionary
        // weekend — always treat it as "open" so the rotation never
        // blocks it, and so a stale auto-block from before their fixed
        // days changed gets cleaned up by the same logic below.
        const isFixedDay = emp.fixedDays.includes(d.dow);
        // A capped employee with fixed days is ALREADY restricted to
        // only those days everywhere in the matching logic (see
        // respectsFixedDayRestriction) — a weekend that isn't one of
        // their fixed days was never reachable regardless of PTO. Don't
        // bother writing a block that changes nothing but clutters the
        // grid; treat it the same as "open" so it's skipped/cleaned up.
        const structurallyExcluded = !respectsFixedDayRestriction(emp, [d.dow]);
        const wIdx = weekendIndexFor(d.date);
        const shouldBeOpen = isFixedDay || structurallyExcluded || isOpenWeekend(emp.weekendRotation, wIdx);
        const k = key(emp.id, d.idx);
        const currentStatus = ptoStatus[k];
        const currentSource = ptoSource[k];
        if (!shouldBeOpen) {
          if (!currentStatus) toSet.push({ empId: emp.id, iso: d.iso, idx: d.idx });
        } else if (currentStatus === "PTO1" && currentSource === "weekend_rotation") {
          if (!toClearByEmp.has(emp.id)) toClearByEmp.set(emp.id, []);
          toClearByEmp.get(emp.id).push(d.iso);
        }
      });
    });
    if (toSet.length === 0 && toClearByEmp.size === 0) return;
    setPtoStatus((prev) => {
      const next = { ...prev };
      toSet.forEach((u) => { next[key(u.empId, u.idx)] = "PTO1"; });
      toClearByEmp.forEach((isoList, empId) => {
        isoList.forEach((iso) => {
          const d = days.find((dd) => dd.iso === iso);
          if (d) delete next[key(empId, d.idx)];
        });
      });
      return next;
    });
    setPtoSource((prev) => {
      const next = { ...prev };
      toSet.forEach((u) => { next[key(u.empId, u.idx)] = "weekend_rotation"; });
      toClearByEmp.forEach((isoList, empId) => {
        isoList.forEach((iso) => {
          const d = days.find((dd) => dd.iso === iso);
          if (d) delete next[key(empId, d.idx)];
        });
      });
      return next;
    });
    if (toSet.length) {
      bulkUpsertPtoStatus(toSet.map((u) => ({ employee_id: u.empId, day_iso: u.iso, status: "PTO1", source: "weekend_rotation", owner_id: viewingOwnerId }))).catch(reportSyncError);
    }
    toClearByEmp.forEach((isoList, empId) => {
      clearPtoStatusForDates(empId, isoList, "weekend_rotation", viewingOwnerId).catch(reportSyncError);
    });
  };
  // Bulk block/clear a date range as PTO-1 (hard, non-overridable) — for
  // extended absences like medical leave, instead of clicking each day.
  const blockLeave = (empId) => {
    if (!leaveStart || !leaveEnd || leaveStart > leaveEnd) return;
    const affected = days.filter((d) => d.iso >= leaveStart && d.iso <= leaveEnd);
    if (affected.length === 0) return;
    setPtoStatus((prev) => {
      const next = { ...prev };
      affected.forEach((d) => { next[key(empId, d.idx)] = "PTO1"; });
      return next;
    });
    setPtoSource((prev) => {
      const next = { ...prev };
      affected.forEach((d) => { next[key(empId, d.idx)] = "manual"; });
      return next;
    });
    bulkUpsertPtoStatus(affected.map((d) => ({ employee_id: empId, day_iso: d.iso, status: "PTO1", source: "manual", owner_id: viewingOwnerId }))).catch(reportSyncError);
  };
  const clearLeave = (empId) => {
    if (!leaveStart || !leaveEnd || leaveStart > leaveEnd) return;
    const affected = days.filter((d) => d.iso >= leaveStart && d.iso <= leaveEnd);
    if (affected.length === 0) return;
    setPtoStatus((prev) => {
      const next = { ...prev };
      affected.forEach((d) => { delete next[key(empId, d.idx)]; });
      return next;
    });
    setPtoSource((prev) => {
      const next = { ...prev };
      affected.forEach((d) => { delete next[key(empId, d.idx)]; });
      return next;
    });
    bulkDeletePtoStatus(empId, leaveStart, leaveEnd, viewingOwnerId).catch(reportSyncError);
  };
  const cyclePto = (empId, dayIdx) => {
    const k = key(empId, dayIdx);
    const iso = days[dayIdx]?.iso;
    // Any manual click claims the cell — future "Apply weekend rotation"
    // runs will never touch it again, even if it started out auto-set.
    setPtoSource((prev) => {
      const next = { ...prev };
      if (ptoStatus[k] === "PTO2") delete next[k]; // about to clear
      else next[k] = "manual";
      return next;
    });
    setPtoStatus((prev) => {
      const next = { ...prev };
      let newStatus = null;
      if (next[k] === "PTO1") { next[k] = "PTO2"; newStatus = "PTO2"; }
      else if (next[k] === "PTO2") { delete next[k]; }
      else { next[k] = "PTO1"; newStatus = "PTO1"; }
      if (iso) (newStatus ? upsertPtoStatus(empId, iso, newStatus, "manual", viewingOwnerId) : deletePtoStatus(empId, iso, viewingOwnerId)).catch(reportSyncError);
      return next;
    });
  };
  const toggleExtraAvail = (empId, dayIdx) => {
    const k = key(empId, dayIdx);
    const iso = days[dayIdx]?.iso;
    setExtraAvailable((prev) => {
      const next = { ...prev };
      const willBeAvailable = !next[k];
      if (willBeAvailable) next[k] = true; else delete next[k];
      if (iso) (willBeAvailable ? addExtraAvailabilityRow(empId, iso, viewingOwnerId) : removeExtraAvailabilityRow(empId, iso, viewingOwnerId)).catch(reportSyncError);
      return next;
    });
  };
  const addHoliday = () => {
    if (!holidayInput) return;
    const iso = holidayInput;
    setHolidays((prev) => new Set(prev).add(iso));
    setHolidayInput("");
    addHolidayRow(iso, viewingOwnerId).catch(reportSyncError);
  };
  const removeHoliday = (iso) => {
    setHolidays((prev) => { const n = new Set(prev); n.delete(iso); return n; });
    removeHolidayRow(iso, viewingOwnerId).catch(reportSyncError);
  };
  // IDs are assigned by the database, not guessed client-side — with
  // multiple managers each only seeing their own roster, "1 more than
  // the highest ID I can see" is no longer unique across everyone's
  // employees combined. So this waits for the real row back before
  // adding it to local state, instead of adding an optimistic guess.
  const addExtra = async () => {
    if (!newExtraName.trim() || newExtraShifts.length === 0) return;
    const draft = { name: newExtraName.trim(), type: "extra", fixedDays: [], allowedShifts: [...newExtraShifts] };
    setNewExtraName(""); setNewExtraShifts([]);
    try {
      const saved = await insertEmployee(draft, viewingOwnerId);
      setEmployees((prev) => [...prev, saved]);
    } catch (err) {
      reportSyncError(err);
    }
  };
  // Team size isn't fixed — add as many or as few permanent employees as
  // the roster actually needs. New hires start with no fixed days, no
  // cap, and the same default weekend rotation as everyone else, and
  // are fully editable afterward from their row below.
  const addPermanent = async () => {
    if (!newPermanentName.trim()) return;
    const draft = {
      name: newPermanentName.trim(), type: "permanent", fixedDays: [], allowedShifts: [...ALL_SHIFT_CODES],
      shiftCap: null, weekendRotation: { cycleWeekends: 4, openOffset: 0 },
    };
    setNewPermanentName("");
    try {
      const saved = await insertEmployee(draft, viewingOwnerId);
      setEmployees((prev) => [...prev, saved]);
    } catch (err) {
      reportSyncError(err);
    }
  };
  // Shared by both rosters — removing an employee works the same way
  // regardless of type, so one function instead of two near-duplicates.
  const removeEmployee = (emp) => {
    if (!window.confirm(`Remove ${emp.name} (${emp.type === "permanent" ? "permanent employee" : "PRN"})? This also deletes their PTO history.`)) return;
    setEmployees((prev) => prev.filter((e) => e.id !== emp.id));
    deleteEmployee(emp.id, viewingOwnerId).catch(reportSyncError);
  };
  const convertToPermanent = (id) =>
    setEmployees((prev) => prev.map((e) => {
      if (e.id !== id) return e;
      const updated = { ...e, type: "permanent", allowedShifts: [...ALL_SHIFT_CODES] };
      upsertEmployee(updated, viewingOwnerId).catch(reportSyncError);
      return updated;
    }));

  // ---- Continuity block pre-pass (e.g. E7) ----
  // committedDays tracks days already claimed by an EARLIER continuity
  // code in this same generation pass (keyed "p:<id>" / "x:<id>" so
  // permanent and extra ids can't collide). Without this, two continuity
  // shifts computed independently could both pick the same employee for
  // the same day — a real double-booking that the schedule grid then
  // hides, since it only ever renders one shift per employee per day.
  const assignContinuityBlocks = (code, rule, committedDays) => {
    const dayAssignment = {};
    if (!weekdayShifts.includes(code)) return dayAssignment;

    const runs = [];
    let current = [];
    days.forEach((d) => {
      const isOff = d.isWeekend || holidays.has(d.iso);
      if (!isOff) current.push(d); else { if (current.length) runs.push(current); current = []; }
    });
    if (current.length) runs.push(current);

    const stat = {}; permanent.forEach((e) => { stat[e.id] = 0; });
    const extraStat = {}; extra.forEach((e) => { extraStat[e.id] = 0; });
    const workedDaysByEmp = {}; permanent.forEach((e) => { workedDaysByEmp[e.id] = []; });
    const claim = (idKey, indices) => { if (!committedDays[idKey]) committedDays[idKey] = new Set(); indices.forEach((idx) => committedDays[idKey].add(idx)); };
    const isCommitted = (idKey, blockDays) => blockDays.some((d) => committedDays[idKey]?.has(d.idx));

    runs.forEach((run) => {
      const lens = partitionRun(run.length, rule.minDays, rule.maxDays);
      if (!lens) return; // impossible run length — left as holes
      let offset = 0;
      lens.forEach((blockLen) => {
        const blockDays = run.slice(offset, offset + blockLen);
        const blockDayIndices = blockDays.map((d) => d.idx);
        offset += blockLen;
        const anyPto1 = (e) => blockDays.some((d) => ptoStatus[key(e.id, d.idx)] === "PTO1");
        const underCap = (e) => !wouldExceedShiftCap(e, workedDaysByEmp[e.id], blockDayIndices);
        const blockDows = blockDays.map((d) => d.dow);
        const fitsFixedDays = (e) => respectsFixedDayRestriction(e, blockDows);
        const tier1 = permanent.filter((e) => blockDays.every((d) => !ptoStatus[key(e.id, d.idx)]) && underCap(e) && fitsFixedDays(e) && !isCommitted(`p:${e.id}`, blockDays));
        const tier2 = permanent.filter((e) => !anyPto1(e) && blockDays.some((d) => ptoStatus[key(e.id, d.idx)] === "PTO2") && underCap(e) && fitsFixedDays(e) && !isCommitted(`p:${e.id}`, blockDays));
        const sortFn = (a, b) => stat[a.id] - stat[b.id] || Math.random() - 0.5;
        let chosen = null, type = "permanent", override = false;
        if (tier1.length) { tier1.sort(sortFn); chosen = tier1[0]; }
        else if (tier2.length) { tier2.sort(sortFn); chosen = tier2[0]; override = true; }
        else {
          const poolE = extra.filter((e) => e.allowedShifts.includes(code) && blockDays.every((d) => extraAvailable[key(e.id, d.idx)]) && !isCommitted(`x:${e.id}`, blockDays));
          if (poolE.length) { poolE.sort((a, b) => extraStat[a.id] - extraStat[b.id]); chosen = poolE[0]; type = "extra"; }
        }
        if (chosen) {
          blockDays.forEach((d) => { dayAssignment[d.idx] = { empId: chosen.id, type, override }; });
          if (type === "permanent") { stat[chosen.id] += blockLen; workedDaysByEmp[chosen.id].push(...blockDayIndices); claim(`p:${chosen.id}`, blockDayIndices); }
          else { extraStat[chosen.id] += blockLen; claim(`x:${chosen.id}`, blockDayIndices); }
        }
      });
    });
    return dayAssignment;
  };

  // ---- Weekend rotation guarantee pre-pass (capped employees only) ----
  // An hour-capped employee's rolling cap can quietly get used up by
  // regular WEEKDAY shifts before their assigned "open" weekend arrives
  // later in the same window — the cap check has no way to know a future
  // commitment is coming, so it correctly (but unhelpfully) blocks them
  // on their own weekend, and PRN fills the hole instead. Uncapped
  // employees can't hit this — wouldExceedShiftCap always passes when
  // emp.shiftCap is unset — so this only needs to run for capped staff.
  // Same fix shape as the continuity pre-pass above: decide these days
  // FIRST, before the regular walk can spend the shared cap budget
  // elsewhere.
  const assignWeekendRotationGuarantees = () => {
    const dayAssignment = {}; // dayIdx -> { [shift]: { empId, type, override, fixed } }
    const workedDaysByEmp = {}; permanent.forEach((e) => { workedDaysByEmp[e.id] = []; });
    const stat = {}; permanent.forEach((e) => { stat[e.id] = 0; });
    const weekendDays = days.filter((d) => d.isWeekend || holidays.has(d.iso));
    // This pre-pass runs before any weekday shift is decided, so it can't
    // see an employee's actual weekday assignments yet to judge whether
    // guaranteeing them this weekend would create too long a streak. Their
    // fixed days ARE known in advance and near-guaranteed to be worked
    // (barring their own cap/streak exclusions), so treat every fixed-day
    // occurrence in the schedule as "worked" for this estimate — a
    // realistic, if conservative, stand-in for the days that haven't
    // been decided yet.
    const projectedFixedDayIndices = {};
    permanent.forEach((e) => { projectedFixedDayIndices[e.id] = days.filter((d) => e.fixedDays.includes(d.dow)).map((d) => d.idx); });

    weekendDays.forEach((day) => {
      const activeShifts = weekendShifts.filter((s) => !isContinuityCode(s));
      const candidates = permanent.filter((e) =>
        e.shiftCap
        && !e.fixedDays.includes(day.dow) // fixed days already get guaranteed priority elsewhere
        && ptoStatus[key(e.id, day.idx)] !== "PTO1"
        && isOpenWeekend(e.weekendRotation, weekendIndexFor(day.date))
        && respectsFixedDayRestriction(e, [day.dow])
        && !wouldExceedShiftCap(e, workedDaysByEmp[e.id], [day.idx])
        && !wouldExceedConsecutiveDays([...projectedFixedDayIndices[e.id], ...workedDaysByEmp[e.id]], [day.idx], consecutiveHardLimit ? maxConsecutiveDays : 0));
      if (!candidates.length) return;
      const match = kuhnMatch(activeShifts, (shift) =>
        candidates.map((e) => e.id).sort((a, b) => stat[a] - stat[b] || Math.random() - 0.5));
      Object.entries(match).forEach(([shift, empId]) => {
        if (!dayAssignment[day.idx]) dayAssignment[day.idx] = {};
        dayAssignment[day.idx][shift] = { empId, type: "permanent", override: false, fixed: true };
        stat[empId] += 1;
        workedDaysByEmp[empId].push(day.idx);
      });
    });
    return { dayAssignment, workedDaysByEmp };
  };

  const assignDay = (day, stats, extraStats, preAssigned = {}, capWorkedDays) => {
    const isWknd = day.isWeekend || holidays.has(day.iso);
    const activeShifts = isWknd ? weekendShifts : weekdayShifts;
    const statusOf = (id) => ptoStatus[key(id, day.idx)];
    const assignment = { ...preAssigned };
    const usedIds = new Set(Object.values(preAssigned).map((e) => e.empId));
    let remaining = activeShifts.filter((s) => !(s in preAssigned) && !isContinuityCode(s));
    // Kuhn's algorithm processes slots in array order and greedily locks
    // in the first match it finds. Without shuffling, a lone candidate
    // (e.g. the only fixed-day employee working today) would always be
    // bound to whichever shift happens to be first in weekdayShiftCodes
    // (E1) — every day, for the whole rotation — instead of rotating
    // across codes. Randomizing the slot order fixes that.
    for (let i = remaining.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
    }

    // capWorkedDays is pre-seeded (in generate()) with each capped
    // employee's continuity-block days across the WHOLE rotation before
    // this day-by-day walk starts — unlike stats.workedDays, which only
    // picks up continuity days as the walk reaches them, so a shift
    // assigned today can't "not know" about a continuity block already
    // locked in for two weeks from now.
    const underCap = (e) => !wouldExceedShiftCap(e, capWorkedDays[e.id], [day.idx]);
    // Only bites in hard mode (maxConsecutiveDays passed as 0 disables
    // the check entirely, same trick wouldExceedShiftCap uses for "no
    // cap set"). In soft mode this preference is handled purely through
    // the cost function in costOf, so it never blocks an assignment.
    const underStreak = (e) => !wouldExceedConsecutiveDays(capWorkedDays[e.id], [day.idx], consecutiveHardLimit ? maxConsecutiveDays : 0);
    const fixedToday = permanent.filter((e) => e.fixedDays.includes(day.dow) && statusOf(e.id) !== "PTO1" && underCap(e) && underStreak(e));
    if (fixedToday.length && remaining.length) {
      const match = kuhnMatch(remaining, (shift) =>
        fixedToday.filter((e) => !usedIds.has(e.id)).map((e) => e.id)
          .sort((a, b) => shiftPref(stats[a], shift) - shiftPref(stats[b], shift) || Math.random() - 0.5));
      Object.entries(match).forEach(([shift, empId]) => { assignment[shift] = { empId, type: "permanent", override: false, fixed: true }; usedIds.add(empId); });
      remaining = remaining.filter((s) => !(s in match));
    }
    if (remaining.length) {
      const pool = permanent.filter((e) => !usedIds.has(e.id) && !statusOf(e.id) && underCap(e) && underStreak(e) && respectsFixedDayRestriction(e, [day.dow]));
      const costFn = (id, shift) => shiftPref(stats[id], shift) + (isWknd ? stats[id].weekendCount * 1000 : 0) + stats[id].totalWorked * 10;
      const match = kuhnMatch(remaining, (shift) => pool.filter((e) => !usedIds.has(e.id)).map((e) => e.id).sort((a, b) => costFn(a, shift) - costFn(b, shift) || Math.random() - 0.5));
      Object.entries(match).forEach(([shift, empId]) => { assignment[shift] = { empId, type: "permanent", override: false, fixed: false }; usedIds.add(empId); });
      remaining = remaining.filter((s) => !(s in match));
    }
    if (remaining.length) {
      const pool2 = permanent.filter((e) => !usedIds.has(e.id) && statusOf(e.id) === "PTO2" && underCap(e) && underStreak(e) && respectsFixedDayRestriction(e, [day.dow]));
      const match = kuhnMatch(remaining, (shift) => pool2.filter((e) => !usedIds.has(e.id)).map((e) => e.id).sort((a, b) => stats[a].totalWorked - stats[b].totalWorked || Math.random() - 0.5));
      Object.entries(match).forEach(([shift, empId]) => { assignment[shift] = { empId, type: "permanent", override: true, fixed: false }; usedIds.add(empId); });
      remaining = remaining.filter((s) => !(s in match));
    }
    if (remaining.length) {
      const poolE = extra.filter((e) => !usedIds.has(e.id) && extraAvailable[key(e.id, day.idx)]);
      const match = kuhnMatch(remaining, (shift) =>
        poolE.filter((e) => e.allowedShifts.includes(shift) && !usedIds.has(e.id)).map((e) => e.id).sort((a, b) => extraStats[a].totalWorked - extraStats[b].totalWorked || Math.random() - 0.5));
      Object.entries(match).forEach(([shift, empId]) => { assignment[shift] = { empId, type: "extra", override: false, fixed: false }; usedIds.add(empId); });
      remaining = remaining.filter((s) => !(s in match));
    }

    Object.entries(assignment).forEach(([shift, info]) => {
      if (!preAssigned[shift] && info.type === "permanent") {
        const st = stats[info.empId];
        st.totalWorked++; st.shiftCount[shift]++; st.workedDays.push(day.idx);
        capWorkedDays[info.empId].push(day.idx);
        if (isWknd) { st.weekendCount++; st.weekendDaysWorked.push(day.idx); }
      } else if (!preAssigned[shift] && info.type === "extra") {
        extraStats[info.empId].totalWorked++;
      }
    });

    const continuityHoles = activeShifts.filter((s) => isContinuityCode(s) && !(s in preAssigned));
    return { ...day, isWknd, activeShifts, assignment, holes: [...remaining, ...continuityHoles] };
  };

  const computeStats = (daysArr) => {
    const stats = {};
    permanent.forEach((e) => { stats[e.id] = { totalWorked: 0, shiftCount: Object.fromEntries(ALL_SHIFT_CODES.map((s) => [s, 0])), weekendCount: 0, weekendDaysWorked: [], workedDays: [] }; });
    daysArr.forEach((day) => {
      Object.entries(day.assignment).forEach(([shift, info]) => {
        if (info.type === "permanent") {
          const st = stats[info.empId];
          st.totalWorked++; st.shiftCount[shift]++; st.workedDays.push(day.idx);
          if (day.isWknd) { st.weekendCount++; st.weekendDaysWorked.push(day.idx); }
        }
      });
    });
    return stats;
  };

  const costOf = (daysArr, totalDaysCount) => {
    const stats = computeStats(daysArr);
    // Capped employees (extended-hour schedules, ~half the normal shift
    // count by design) are structurally different, not "unfair" — leave
    // them out of the total/per-shift spread comparison so their lower
    // count doesn't look like an imbalance the optimizer should chase.
    const standardPermanent = permanent.filter((e) => !e.shiftCap);
    let totalSpread = 0;
    if (standardPermanent.length > 0) {
      const totals = standardPermanent.map((e) => stats[e.id].totalWorked);
      totalSpread = Math.max(...totals) - Math.min(...totals);
    }
    let shiftSpread = 0;
    if (standardPermanent.length > 0) {
      ALL_SHIFT_CODES.forEach((s) => { const vals = standardPermanent.map((e) => stats[e.id].shiftCount[s]); shiftSpread += Math.max(...vals) - Math.min(...vals); });
    }
    let weekendViol = 0;
    permanent.forEach((e) => {
      const wd = stats[e.id].weekendDaysWorked;
      let maxGap = wd.length === 0 ? totalDaysCount : wd[0];
      for (let i = 1; i < wd.length; i++) maxGap = Math.max(maxGap, wd[i] - wd[i - 1]);
      if (wd.length) maxGap = Math.max(maxGap, totalDaysCount - 1 - wd[wd.length - 1]);
      if (totalDaysCount > 28 && maxGap > 28) weekendViol++;
    });
    // Every permanent employee should work each active shift at least
    // once this rotation — but only if they had any non-blocked day to
    // work it on at all (skip anyone on leave for the whole span).
    let missingShiftPenalty = 0;
    permanent.forEach((e) => {
      const hasAvailability = daysArr.some((d) => ptoStatus[key(e.id, d.idx)] !== "PTO1");
      if (!hasAvailability) return;
      weekdayShifts.forEach((s) => { if (stats[e.id].shiftCount[s] === 0) missingShiftPenalty++; });
    });
    // In hard mode this always evaluates to 0 — the hard checks in
    // assignDay/assignWeekendRotationGuarantees never let a run form in
    // the first place. In soft mode it's the only thing driving local
    // search to break up a long streak, scaled by how far over the line
    // it is so a 10-day run outweighs an 8-day one.
    let consecutiveRunPenalty = 0;
    if (maxConsecutiveDays > 0) {
      permanent.forEach((e) => {
        const run = longestConsecutiveRun(stats[e.id].workedDays);
        if (run > maxConsecutiveDays) consecutiveRunPenalty += run - maxConsecutiveDays;
      });
    }
    return totalSpread * 5 + shiftSpread * 1 + weekendViol * 50 + missingShiftPenalty * 40 + consecutiveRunPenalty * 35;
  };

  const localSearch = (initialDays, iterations = 2500) => {
    let current = initialDays.map((d) => ({ ...d, assignment: { ...d.assignment } }));
    let currentCost = costOf(current, current.length);
    for (let i = 0; i < iterations; i++) {
      const dIdx = Math.floor(Math.random() * current.length);
      const day = current[dIdx];
      const entries = Object.entries(day.assignment).filter(([shift, info]) => info.type === "permanent" && !info.fixed && !info.override && !isContinuityCode(shift));
      const moveType = Math.random() < 0.5 ? "A" : "B";
      let trialAssignment = { ...day.assignment };
      let mutated = false;

      if (moveType === "A" && entries.length >= 2) {
        const idx1 = Math.floor(Math.random() * entries.length);
        let idx2 = Math.floor(Math.random() * entries.length);
        while (idx2 === idx1) idx2 = Math.floor(Math.random() * entries.length);
        const [shift1, info1] = entries[idx1];
        const [shift2, info2] = entries[idx2];
        trialAssignment[shift1] = { ...info1, empId: info2.empId };
        trialAssignment[shift2] = { ...info2, empId: info1.empId };
        mutated = true;
      } else if (moveType === "B" && entries.length >= 1) {
        const [shiftX, infoX] = entries[Math.floor(Math.random() * entries.length)];
        const usedIds = new Set(Object.values(day.assignment).map((v) => v.empId));
        const candidatesY = permanent.filter((e) => !usedIds.has(e.id) && !e.fixedDays.includes(day.dow) && !ptoStatus[key(e.id, day.idx)]
          && !wouldExceedShiftCap(e, workedDayIndicesFromSchedule(current, e.id), [day.idx])
          && !wouldExceedConsecutiveDays(workedDayIndicesFromSchedule(current, e.id), [day.idx], consecutiveHardLimit ? maxConsecutiveDays : 0)
          && respectsFixedDayRestriction(e, [day.dow]));
        if (candidatesY.length) {
          const Y = candidatesY[Math.floor(Math.random() * candidatesY.length)];
          trialAssignment[shiftX] = { ...infoX, empId: Y.id };
          mutated = true;
        }
      }
      if (!mutated) continue;

      const trialDays = [...current];
      trialDays[dIdx] = { ...day, assignment: trialAssignment };
      const trialCost = costOf(trialDays, current.length);
      if (trialCost <= currentCost) { current = trialDays; currentCost = trialCost; }
    }
    return { days: current, finalCost: currentCost };
  };

  const verifyContinuity = (daysArr) => {
    const violations = [];
    const runsByCode = {};
    Object.entries(continuityRules).forEach(([code, rule]) => {
      runsByCode[code] = [];
      permanent.forEach((emp) => {
        const workedIdx = daysArr.filter((d) => d.assignment[code] && d.assignment[code].empId === emp.id).map((d) => d.idx).sort((a, b) => a - b);
        let runLen = 0, prev = null;
        const runs = [];
        workedIdx.forEach((idx) => {
          if (prev !== null && idx === prev + 1) runLen++;
          else { if (runLen > 0) runs.push(runLen); runLen = 1; }
          prev = idx;
        });
        if (runLen > 0) runs.push(runLen);
        runs.forEach((len) => {
          runsByCode[code].push(len);
          if (len < rule.minDays || len > rule.maxDays) violations.push(`${emp.name}: ${shiftLabel(code)} ran ${len} day(s) in a row (needs ${rule.minDays}-${rule.maxDays})`);
        });
      });
    });
    return { violations, runsByCode };
  };

  // Defense-in-depth check, same pattern as verifyContinuity: the cap is
  // meant to be respected by construction (assignContinuityBlocks,
  // assignDay, and localSearch's Move B all filter on it), this just
  // confirms the final schedule actually holds up and surfaces it if not.
  const verifyShiftCaps = (daysArr) => {
    const violations = [];
    permanent.forEach((emp) => {
      if (!emp.shiftCap) return;
      const { windowDays, maxShifts } = emp.shiftCap;
      const workedIdx = daysArr.filter((d) => Object.values(d.assignment).some((a) => a.empId === emp.id)).map((d) => d.idx).sort((a, b) => a - b);
      for (const windowStart of workedIdx) {
        const countInWindow = workedIdx.filter((idx) => idx >= windowStart && idx < windowStart + windowDays).length;
        if (countInWindow > maxShifts) {
          violations.push(`${emp.name}: ${countInWindow} shifts within a ${windowDays}-day span (cap is ${maxShifts})`);
          break;
        }
      }
    });
    return violations;
  };

  // Same defense-in-depth idea: a capped employee with fixed days set is
  // meant to work ONLY those days (unlike a standard employee, for whom
  // fixed days are just a guaranteed minimum). Confirms that held.
  const verifyCappedFixedDays = (daysArr) => {
    const violations = [];
    permanent.forEach((emp) => {
      if (!emp.shiftCap || emp.fixedDays.length === 0) return;
      const offDays = daysArr.filter((d) => Object.values(d.assignment).some((a) => a.empId === emp.id) && !emp.fixedDays.includes(d.dow));
      if (offDays.length > 0) {
        violations.push(`${emp.name}: worked ${offDays.length} day(s) outside their fixed days`);
      }
    });
    return violations;
  };

  const generate = () => {
    setGenerating(true);
    setTimeout(() => {
      const stats = {};
      permanent.forEach((e) => { stats[e.id] = { totalWorked: 0, shiftCount: Object.fromEntries(ALL_SHIFT_CODES.map((s) => [s, 0])), weekendCount: 0, weekendDaysWorked: [], workedDays: [] }; });
      const extraStats = {};
      extra.forEach((e) => { extraStats[e.id] = { totalWorked: 0 }; });

      const continuityByCode = {};
      const continuityCommittedDays = {};
      Object.entries(continuityRules).forEach(([code, rule]) => { continuityByCode[code] = assignContinuityBlocks(code, rule, continuityCommittedDays); });

      const { dayAssignment: weekendGuaranteed, workedDaysByEmp: weekendGuaranteedDays } = assignWeekendRotationGuarantees();

      // Continuity blocks and guaranteed weekend-rotation days are both
      // decided for the WHOLE rotation in one shot above, before any
      // regular-day assignment happens. Seed the cap tracker with all of
      // it up front — otherwise a regular shift handed out early in the
      // walk wouldn't "know" about a commitment already locked in for
      // this employee two weeks later, and the two together could
      // quietly blow past their cap.
      const capWorkedDays = {};
      permanent.forEach((e) => { capWorkedDays[e.id] = [...weekendGuaranteedDays[e.id]]; });
      days.forEach((day) => {
        Object.values(continuityByCode).forEach((map) => {
          const entry = map[day.idx];
          if (entry && entry.type === "permanent") capWorkedDays[entry.empId].push(day.idx);
        });
      });

      const initialDays = days.map((day) => {
        const preToday = {};
        Object.entries(continuityByCode).forEach(([code, map]) => { if (map[day.idx]) preToday[code] = map[day.idx]; });
        if (weekendGuaranteed[day.idx]) Object.entries(weekendGuaranteed[day.idx]).forEach(([shift, entry]) => { preToday[shift] = entry; });
        Object.entries(preToday).forEach(([shift, entry]) => {
          if (entry.type === "permanent") {
            const st = stats[entry.empId];
            st.totalWorked++; st.shiftCount[shift]++; st.workedDays.push(day.idx);
            const isWknd = day.isWeekend || holidays.has(day.iso);
            if (isWknd) { st.weekendCount++; st.weekendDaysWorked.push(day.idx); }
          } else { extraStats[entry.empId].totalWorked++; }
        });
        return assignDay(day, stats, extraStats, preToday, capWorkedDays);
      });

      const costBefore = costOf(initialDays, initialDays.length);
      const { days: optimizedDays, finalCost: costAfter } = localSearch(initialDays, 2500);

      let totalHoles = 0, totalOverrides = 0;
      optimizedDays.forEach((d) => {
        totalHoles += d.holes.length;
        Object.values(d.assignment).forEach((info) => { if (info.override) totalOverrides++; });
      });

      const totalDays = optimizedDays.length;
      const finalStats = computeStats(optimizedDays);
      const fairness = permanent.map((e) => {
        const st = finalStats[e.id];
        const offDays = optimizedDays.filter((d) => !Object.values(d.assignment).some((a) => a.empId === e.id) && ptoStatus[key(e.id, d.idx)] !== "PTO1" && ptoStatus[key(e.id, d.idx)] !== "PTO2").length;
        const pto1Days = optimizedDays.filter((d) => ptoStatus[key(e.id, d.idx)] === "PTO1").length;
        const pto2Honored = optimizedDays.filter((d) => ptoStatus[key(e.id, d.idx)] === "PTO2" && !Object.values(d.assignment).some((a) => a.empId === e.id && a.override)).length;
        const pto2Overridden = optimizedDays.filter((d) => ptoStatus[key(e.id, d.idx)] === "PTO2" && Object.values(d.assignment).some((a) => a.empId === e.id && a.override)).length;
        const wd = st.weekendDaysWorked;
        let maxGap = wd.length === 0 ? totalDays : wd[0];
        for (let i = 1; i < wd.length; i++) maxGap = Math.max(maxGap, wd[i] - wd[i - 1]);
        if (wd.length) maxGap = Math.max(maxGap, totalDays - 1 - wd[wd.length - 1]);
        const weekendRuleBroken = totalDays > 28 && maxGap > 28;
        const hasAvailability = optimizedDays.some((d) => ptoStatus[key(e.id, d.idx)] !== "PTO1");
        const missingShifts = hasAvailability ? weekdayShifts.filter((s) => st.shiftCount[s] === 0) : [];
        const longestRun = longestConsecutiveRun(st.workedDays);
        const longestRunExceeded = maxConsecutiveDays > 0 && longestRun > maxConsecutiveDays;
        return { id: e.id, name: e.name, fixedDays: e.fixedDays, shiftCap: e.shiftCap || null, total: st.totalWorked, perShift: st.shiftCount, offDays, pto1Days, pto2Honored, pto2Overridden, weekendCount: st.weekendCount, weekendRuleBroken, missingShifts, longestRun, longestRunExceeded };
      });
      const extraFairness = extra.map((e) => {
        const total = optimizedDays.reduce((sum, d) => sum + Object.values(d.assignment).filter((a) => a.empId === e.id && a.type === "extra").length, 0);
        return { id: e.id, name: e.name, allowedShifts: e.allowedShifts, total };
      });

      const continuityCheck = verifyContinuity(optimizedDays);
      const employeesMissingShifts = fairness.filter((f) => f.missingShifts.length > 0).length;
      const shiftCapViolations = verifyShiftCaps(optimizedDays);
      const cappedFixedDayViolations = verifyCappedFixedDays(optimizedDays);

      const scheduleSnapshot = { days: optimizedDays, fairness, extraFairness, totalHoles, totalOverrides, costBefore, costAfter, iterations: 2500, continuityCheck, employeesMissingShifts, shiftCapViolations, cappedFixedDayViolations, numWeeks, startDate };
      setSchedule(scheduleSnapshot);
      saveScheduleSnapshot(scheduleSnapshot, viewingOwnerId).catch(reportSyncError);
      setGenerating(false);
      setTab("schedule");
    }, 30);
  };

  const summary = useMemo(() => {
    if (!schedule) return null;
    const standardFairness = schedule.fairness.filter((f) => !f.shiftCap);
    const totals = standardFairness.map((f) => f.total);
    const totalSpread = totals.length ? Math.max(...totals) - Math.min(...totals) : 0;
    let maxShiftSpread = 0;
    if (standardFairness.length) {
      ALL_SHIFT_CODES.forEach((s) => { const vals = standardFairness.map((f) => f.perShift[s]); maxShiftSpread = Math.max(maxShiftSpread, Math.max(...vals) - Math.min(...vals)); });
    }
    let label = "Excellent balance", tone = "#0D9488";
    if (schedule.employeesMissingShifts > 0 || schedule.shiftCapViolations.length > 0 || schedule.cappedFixedDayViolations.length > 0 || totalSpread > 2 || maxShiftSpread > 3) { label = "Uneven — try more weeks"; tone = "#DC2626"; }
    else if (totalSpread > 1 || maxShiftSpread > 1) { label = "Good balance"; tone = "#CA8A04"; }
    return { totalSpread, maxShiftSpread, label, tone };
  }, [schedule]);

  const cellFor = (employee, day) => {
    const entry = Object.entries(day.assignment).find(([, info]) => info.empId === employee.id);
    if (entry) return { code: entry[0], override: entry[1].override };
    const st = ptoStatus[key(employee.id, day.idx)];
    if (st === "PTO1") return { code: "PTO-1" };
    if (st === "PTO2") return { code: "PTO-2" };
    if (employee.type === "extra") return { code: "" };
    return { code: "OFF" };
  };

  const renderScheduleTable = (list, title) => (
    <div className="bg-white rounded-lg border border-[#E4E7EC] overflow-x-auto mb-4">
      <div className="px-4 py-2 border-b border-[#E4E7EC] text-sm font-semibold">{title}</div>
      <table className="text-xs border-collapse">
        <thead>
          <tr>
            <th className="sticky left-0 bg-white z-10 text-left px-3 py-2 border-b border-[#E4E7EC] min-w-[150px]">Employee</th>
            {schedule.days.map((d) => (
              <th key={d.idx} className={`px-1 py-2 border-b border-[#E4E7EC] font-normal text-center min-w-[36px] ${d.isWknd ? "bg-[#F1F5F9]" : ""}`}>
                <div className="text-[#64748B]">{d.wd[0]}</div><div className="text-[10px]">{d.md}</div>
                {holidays.has(d.iso) && <div className="text-[9px] text-[#DC2626]">HOL</div>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list.map((emp) => (
            <tr key={emp.id}>
              <td className="sticky left-0 bg-white z-10 px-3 py-1 border-b border-[#F1F5F9] font-medium">
                {emp.name}{emp.type === "extra" && <span className="ml-1 text-[9px] text-[#64748B]">PRN</span>}
              </td>
              {schedule.days.map((d) => {
                const { code, override } = cellFor(emp, d);
                const isShift = ALL_SHIFT_CODES.includes(code);
                const displayText = code === "OFF" ? "" : isShift ? shiftLabel(code) : code;
                const bg = isShift ? getShiftColor(code) : code === "PTO-1" ? "#DC2626" : code === "PTO-2" ? "#F59E0B" : code === "OFF" ? "#E4E7EC" : "transparent";
                const fg = isShift || code === "PTO-1" || code === "PTO-2" ? "#fff" : "#64748B";
                return (
                  <td key={d.idx} className="border-b border-[#F1F5F9] p-0.5 text-center">
                    <div
                      className="w-9 h-6 rounded-sm flex items-center justify-center font-mono font-semibold"
                      style={{ background: bg, color: fg, fontSize: gridCellFontSize(displayText), border: override ? "2px dashed #F59E0B" : isContinuityCode(code) ? "2px solid #1A2233" : "none" }}
                      title={isShift && displayText !== code ? code : undefined}
                    >
                      {displayText}{override ? "*" : ""}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
          <tr>
            <td className="sticky left-0 bg-white z-10 px-3 py-1 font-semibold text-[#DC2626]">⚠ Coverage gaps</td>
            {schedule.days.map((d) => (
              <td key={d.idx} className="text-center p-0.5">
                {d.holes.length > 0 ? (
                  <div className="w-9 h-6 rounded-sm flex items-center justify-center font-bold text-[9px] text-white animate-pulse" style={{ background: "#DC2626", boxShadow: "0 0 0 2px #DC2626" }} title={`Unfilled: ${d.holes.map(shiftLabel).join(", ")}`}>HOLE</div>
                ) : null}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );

  if (!loaded) {
    return (
      <div style={{ fontFamily: "'Inter', system-ui, sans-serif" }} className="min-h-screen bg-[#F7F8FA] text-[#1A2233] flex items-center justify-center">
        <div className="text-sm text-[#64748B]">Loading saved data…</div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif" }} className="min-h-screen bg-[#F7F8FA] text-[#1A2233] p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        {syncError && (
          <div className="bg-[#FEE2E2] border border-[#DC2626] text-[#991B1B] text-xs rounded px-3 py-2 mb-4">
            ⚠ Sync error: {syncError} — some changes may not be saved. Check your Supabase connection.
          </div>
        )}
        <header className="mb-6 print-hide">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="text-xs tracking-widest uppercase text-[#64748B] font-semibold mb-1">Fair Rotation Prototype v4</div>
              <h1 className="text-2xl md:text-3xl font-bold">Shift Scheduler</h1>
            </div>
            <div className="flex items-center gap-3 text-xs text-[#64748B]">
              {profile.role === "admin" && allProfiles.length > 1 && (
                <span className="flex items-center gap-1">
                  <label className="text-[10px] uppercase tracking-wide">Viewing:</label>
                  <select
                    value={viewingOwnerId}
                    onChange={(e) => switchViewingOwner(e.target.value)}
                    className="border border-[#E4E7EC] rounded px-2 py-1 text-xs"
                  >
                    {allProfiles.map((p) => (
                      <option key={p.id} value={p.id}>{p.name || p.id}{p.id === session.user.id ? " (you)" : ""}{p.role === "admin" ? " — admin" : ""}</option>
                    ))}
                  </select>
                </span>
              )}
              <span>{profile.name || session.user.email}{profile.role === "admin" && <span className="ml-1 text-[9px] uppercase font-semibold text-[#7C3AED] border border-[#7C3AED] rounded px-1 py-0.5">Admin</span>}</span>
              <button onClick={() => setShowAccountSettings((v) => !v)} className="px-2 py-1 rounded border border-[#E4E7EC] hover:bg-[#F7F8FA]">Account settings</button>
              <button onClick={onSignOut} className="px-2 py-1 rounded border border-[#E4E7EC] hover:bg-[#F7F8FA]">Sign out</button>
            </div>
          </div>
          {showAccountSettings && (
            <AccountSettings
              session={session}
              profile={profile}
              onProfileUpdated={setProfile}
              onClose={() => setShowAccountSettings(false)}
            />
          )}
          {profile.role === "admin" && viewingOwnerId !== session.user.id && (
            <div className="bg-[#EFF6FF] border border-[#BFDBFE] text-[#1E3A8A] text-xs rounded px-3 py-2 mt-2">
              👁 You're viewing and editing {allProfiles.find((p) => p.id === viewingOwnerId)?.name || "another manager"}'s data, not your own.
            </div>
          )}
          <p className="text-[#64748B] mt-1 max-w-3xl text-sm">
            Shift codes, weekend/holiday set, and continuity rules (like a shift needing 2–3 consecutive days) are all set up per manager
            under "Manage shifts" — every team can run its own shift lineup without touching anything else.
          </p>
        </header>

        <div className="flex gap-2 mb-6 border-b border-[#E4E7EC] flex-wrap print-hide">
          {["instructions", "setup", "permanent", "extra", "schedule", "fairness"].map((t) => (
            <button key={t} onClick={() => (t === "instructions" || t === "setup" || t === "permanent" || t === "extra" || schedule) && setTab(t)}
              className={`px-3 py-2 text-sm font-medium capitalize border-b-2 transition-colors ${tab === t ? "border-[#0D9488] text-[#0D9488]" : "border-transparent text-[#64748B] hover:text-[#1A2233]"} ${(t === "schedule" || t === "fairness") && !schedule ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}>
              {{ instructions: "1. Instructions", setup: "2. Setup", permanent: "3. Permanent Staff", extra: "4. PRN Staff", schedule: "5. Schedule", fairness: "6. Fairness Report" }[t]}
            </button>
          ))}
        </div>

        {tab === "instructions" && (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <h2 className="text-lg font-bold">How to use this scheduler</h2>
                <p className="text-xs text-[#64748B] mt-0.5">A quick walkthrough.</p>
              </div>
              <button onClick={() => window.print()} className="px-4 py-2 text-sm font-semibold rounded bg-[#0D9488] text-white hover:bg-[#0B6B62] whitespace-nowrap print-hide">
                ⬇ Download as PDF
              </button>
            </div>

            <div className="bg-white rounded-lg border border-[#E4E7EC] p-4">
              <div className="text-sm font-semibold mb-1">What this app actually does</div>
              <p className="text-xs text-[#64748B]">
                You tell it who's on your team and their rules — who's full-time, who's backup, who can't work weekends, who needs a day off after too many in a row.
                It builds the shift schedule for you, tries to keep it fair, and tells you honestly when something couldn't be solved so you can step in.
              </p>
            </div>

            <div className="bg-white rounded-lg border border-[#E4E7EC] p-4">
              <div className="text-sm font-semibold mb-1">The 6 tabs, in order</div>
              <p className="text-xs text-[#64748B] mb-3">Work through these top to bottom the first time. After that, you'll mostly live in Setup and Schedule.</p>

              <div className="border-t border-[#F1F5F9] pt-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-6 h-6 rounded-full bg-[#E6F6F4] text-[#0B6B62] text-xs font-bold flex items-center justify-center">2</span>
                  <h3 className="text-sm font-semibold">Setup — choose your rotation, don't hit Generate yet</h3>
                </div>
                <ul className="list-disc pl-9 text-xs text-[#33405A] space-y-1 mb-2">
                  <li>Pick how many weeks to schedule and the start date.</li>
                  <li><b>Max consecutive days</b> — your "nobody works more than X days straight" rule. Defaults to 6.</li>
                  <li><b>Hard limit checkbox, unchecked (default):</b> the app just tries to keep everyone at or under that number. It won't always be perfect, but it also won't leave a shift empty just to enforce it.</li>
                  <li><b>Hard limit checkbox, checked:</b> the limit becomes a real rule — nobody ever goes over it, period. If honoring that means a shift has no one left to cover it, that shift goes to backup (PRN) staff instead.</li>
                </ul>
                <img src="/instructions/setup-controls.png" alt="Setup controls: rotation length, start date, max consecutive days, hard limit checkbox, generate button" className="w-full rounded border border-[#E4E7EC] mb-2" />
                <div className="bg-[#FEF3C7] border border-[#FDE68A] text-[#92400E] text-xs rounded px-3 py-2 mb-3">
                  ⏸ <b>Hold off on "Generate schedule" here.</b> It works best as your last step — add your Permanent Staff and PRN Staff first, then come back and generate once your team is actually in the system.
                </div>

                <h3 className="text-sm font-semibold mb-1">Manage shifts — also on this tab</h3>
                <p className="text-xs text-[#33405A] mb-1">This is where you define the actual shift codes your team uses (renamed to whatever you call them). One row per shift:</p>
                <ul className="list-disc pl-9 text-xs text-[#33405A] space-y-1 mb-2">
                  <li><b>Code</b> — the shift's permanent internal ID. Doesn't change.</li>
                  <li><b>Name</b> — what actually shows on the schedule grid (up to 4 characters).</li>
                  <li><b>Weekend/holiday?</b> — tick this if the shift runs on weekends and holidays.</li>
                  <li><b>Continuity?</b> — tick this if the same person must stay on this shift for several days in a row once assigned. The <b>Days</b> column sets that range — see the warning box in the screenshot for which ranges actually work.</li>
                  <li><b>Paused?</b> — takes a shift out of rotation temporarily without deleting its history (max 2 at once).</li>
                </ul>
                <img src="/instructions/manage-shifts.png" alt="Manage shifts table with Code, Name, Weekend/holiday, Continuity, Days, and Paused columns" className="w-full rounded border border-[#E4E7EC]" />
              </div>

              <div className="border-t border-[#F1F5F9] pt-3 mt-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-6 h-6 rounded-full bg-[#E6F6F4] text-[#0B6B62] text-xs font-bold flex items-center justify-center">3</span>
                  <h3 className="text-sm font-semibold">Permanent Staff — build your team</h3>
                </div>
                <ul className="list-disc pl-9 text-xs text-[#33405A] space-y-1 mb-2">
                  <li>Add each employee by name.</li>
                  <li>Tick the days they always work (fixed days), if any.</li>
                  <li>Set their <b>weekend rotation</b> — how often they're on duty for a weekend.</li>
                </ul>
                <img src="/instructions/employee-row.png" alt="One employee row showing fixed days, extended-hour cap, and weekend rotation" className="w-full rounded border border-[#E4E7EC] mb-2" />

                <h3 className="text-sm font-semibold mb-1">"Extended-hour schedule" — use it for two different reasons</h3>
                <p className="text-xs text-[#33405A] mb-1">This one checkbox covers two real situations. Don't skip it just because someone doesn't work 10s or 12s:</p>
                <ul className="list-disc pl-9 text-xs text-[#33405A] space-y-1 mb-2">
                  <li><b>1. Compressed schedules.</b> Anyone working 10-hour or 12-hour shifts — they naturally need fewer shifts to hit full-time hours, so give them a cap that reflects that (e.g. 6 shifts per 14 days).</li>
                  <li><b>2. Regular 8-hour staff too.</b> Recommended: use it to cap them at no more than 10 shifts in any 14-day period — this is <b>not</b> the same as consecutive days. It's a running total (10 shifts spread across 14 days, worked in any pattern), separate from the Max Consecutive Days streak rule. Use both together for full protection: one guards against too many days total, the other against too many days in a row.</li>
                </ul>

                <h3 className="text-sm font-semibold mb-1">Apply weekend rotation — the final step</h3>
                <p className="text-xs text-[#33405A] mb-2">Setting someone's rotation group only records the setting — it doesn't block anything yet. Click this button to actually write those off-weekends onto the schedule as hard blocks. Safe to click again any time you change a rotation or add staff — it never touches a day you've edited by hand.</p>
                <img src="/instructions/apply-rotation.png" alt="Apply weekend rotation button with its explanation banner" className="w-full rounded border border-[#E4E7EC] mb-2" />

                <h3 className="text-sm font-semibold mb-1">The PTO grid — for everything rotation doesn't cover</h3>
                <p className="text-xs text-[#33405A] mb-1">Below the button is a full calendar grid, one row per employee. Click any cell to cycle it through three states — use this for vacation, call-offs, or any one-off day that weekend rotation wouldn't know about:</p>
                <ul className="list-disc pl-9 text-xs text-[#33405A] space-y-1 mb-2">
                  <li><b>Available</b> (blank) → <b>PTO-1, hard block</b> (red) → <b>PTO-2, soft/do-not-schedule</b> (amber) → back to available.</li>
                  <li><b>PTO-1</b> is absolute — honored no matter what, even if it creates a coverage gap.</li>
                  <li><b>PTO-2</b> is a preference — honored unless the schedule genuinely can't be covered without that person.</li>
                  <li>Cells with a dashed purple border were auto-set by "Apply weekend rotation" — clicking one to change it by hand takes it over permanently; that rotation will never overwrite your manual choice again.</li>
                </ul>
                <img src="/instructions/pto-grid.png" alt="PTO grid titled click a cell to cycle: available to PTO-1 hard to PTO-2 soft to available, with legend and red PTO-1 cells set by weekend rotation" className="w-full rounded border border-[#E4E7EC]" />
              </div>

              <div className="border-t border-[#F1F5F9] pt-3 mt-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-6 h-6 rounded-full bg-[#E6F6F4] text-[#0B6B62] text-xs font-bold flex items-center justify-center">4</span>
                  <h3 className="text-sm font-semibold">PRN Staff — your backup bench</h3>
                </div>
                <ul className="list-disc pl-9 text-xs text-[#33405A] space-y-1 mb-2">
                  <li>Add on-call/as-needed people here, and which shifts they're trained on.</li>
                  <li>The app only calls on them when your permanent staff genuinely can't cover a shift — never before.</li>
                  <li>Grown into a regular team member? Use "Convert to permanent" to move them over without re-entering anything.</li>
                </ul>
                <img src="/instructions/prn-staff.png" alt="PRN Staff tab: adding a backup employee, their trained shifts, and the PRN roster with a Convert to permanent option" className="w-full rounded border border-[#E4E7EC]" />
              </div>

              <div className="border-t border-[#F1F5F9] pt-3 mt-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-6 h-6 rounded-full bg-[#E6F6F4] text-[#0B6B62] text-xs font-bold flex items-center justify-center">5</span>
                  <h3 className="text-sm font-semibold">Schedule — your finished grid</h3>
                </div>
                <ul className="list-disc pl-9 text-xs text-[#33405A] space-y-1 mb-2">
                  <li>Every employee, every day, color-coded by shift.</li>
                  <li>A pulsing red <b>HOLE</b> badge means that shift couldn't be filled — hover it to see which shift and why.</li>
                  <li><b>Export CSV</b> turns it into a spreadsheet. <b>Regenerate</b> reruns the optimizer if you want another pass.</li>
                </ul>
                <img src="/instructions/schedule-grid.png" alt="Schedule grid with fairness score, a warning about unfillable shifts, the legend, and export/regenerate buttons" className="w-full rounded border border-[#E4E7EC]" />
              </div>

              <div className="border-t border-[#F1F5F9] pt-3 mt-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-6 h-6 rounded-full bg-[#E6F6F4] text-[#0B6B62] text-xs font-bold flex items-center justify-center">6</span>
                  <h3 className="text-sm font-semibold">Fairness Report — check the results</h3>
                </div>
                <p className="text-xs text-[#33405A] mb-2">Covered in detail further down this page.</p>
                <img src="/instructions/fairness-summary.png" alt="Overall balance summary banner at the top of the Fairness Report" className="w-full rounded border border-[#E4E7EC]" />
              </div>
            </div>

            <div className="bg-white rounded-lg border border-[#E4E7EC] p-4">
              <div className="text-sm font-semibold mb-1">Special tools, explained simply</div>
              <p className="text-xs text-[#64748B] mb-3">These are the settings that solve the trickiest scheduling problems. Worth knowing well.</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                {[
                  ["Feasibility check", "Shows up on Setup, before you even generate. Tells you if you have enough people for the weeks ahead. Red numbers = you're short — add staff or backup coverage first."],
                  ["Weekend rotation", "Not everyone should work every weekend. Set how often someone's on duty (e.g. one weekend a month) — the app blocks their off weekends and protects their on weekend."],
                  ["Fixed work days", "For people who always work the same days (like Mon–Fri). Their schedule locks to those days and never gets moved around."],
                  ["Max consecutive days", "Nobody wants a 10-day stretch with no day off. Set your limit. Soft = the app tries to avoid it. Hard = it's guaranteed, and backup staff cover the gap instead."],
                  ["Extended-hour cap", "Caps total shifts in a rolling window (e.g. 10 per 14 days) — a running total, not a streak. Use for 10s/12s staff, or as an overtime guard on regular 8-hour staff too."],
                  ["Export to CSV", "One click turns the finished schedule into a spreadsheet file — print it, email it, or drop it into whatever else you use."],
                  ["Manage shifts", "Rename shifts, add or remove them, and set \"continuity\" rules for shifts that need the same person for a few days straight."],
                ].map(([title, body]) => (
                  <div key={title} className="border border-[#E4E7EC] rounded-lg p-3 bg-[#FAFBFC]">
                    <div className="flex items-center gap-1.5 text-xs font-bold mb-1">
                      <span className="w-2 h-2 rounded-full bg-[#0D9488] inline-block" />
                      {title}
                    </div>
                    <p className="text-xs text-[#64748B]">{body}</p>
                  </div>
                ))}
              </div>
              <img src="/instructions/feasibility.png" alt="Feasibility check card showing required shifts, available shifts, shortfall, and a weekend-by-weekend shortage table" className="w-full rounded border border-[#E4E7EC]" />
            </div>

            <div className="bg-white rounded-lg border border-[#E4E7EC] p-4">
              <div className="text-sm font-semibold mb-1">Case study: a genuinely messy week</div>
              <p className="text-xs text-[#64748B] mb-3">
                A composite example built from real problems this app has actually hit and fixed — not a hypothetical.
                Picture a manager with 11 extended-hour staff, tight PTO, and one shift that needs the same person for 2–3 days running.
              </p>

              {[
                {
                  title: "Problem 1 — \"We don't have enough people for the weekends coming up\"",
                  body: "Before generating anything, the Feasibility check flags several weekends short by 2–5 people.",
                  fix: "Feasibility check",
                  after: "It caught this before a single shift was scheduled — giving the manager time to add backup (PRN) coverage instead of discovering the gap after the fact.",
                },
                {
                  title: "Problem 2 — \"My extended-hour staff keep missing their own assigned weekend\"",
                  body: "Staff with a shift cap (e.g. max 10 shifts per 14 days) were using up their quota on regular weekdays — so by the time their rotation-assigned weekend came around, they had no quota left. Backup staff filled in instead, even though it was that employee's turn.",
                  fix: "Weekend rotation guarantee",
                  after: "The app now reserves an extended-hour employee's assigned weekend before handing out their regular weekday shifts — so their own weekend doesn't quietly get eaten by the rest of the week.",
                },
                {
                  title: "Problem 3 — \"One employee worked 9 days in a row\"",
                  body: "A fixed Mon–Fri employee also picked up the adjoining weekend, bridging two work-weeks into one long stretch. Nothing caught it — the app had no concept of \"days in a row\" at all.",
                  fix: "Max consecutive days",
                  after: "Soft mode (the default) nudges the schedule to avoid this, without leaving shifts unfilled. Hard mode makes 6 days an absolute ceiling — if honoring it means one shift has to go to backup staff instead, that's the trade it makes.",
                  shot: true,
                },
              ].map((p) => (
                <div key={p.title} className="border border-[#E4E7EC] rounded-lg overflow-hidden mb-3">
                  <div className="bg-[#FEF2F2] text-[#991B1B] px-3 py-2 text-xs font-bold">⚠ {p.title}</div>
                  <div className="p-3">
                    <p className="text-xs text-[#33405A] mb-2">{p.body}</p>
                    <span className="inline-block bg-[#ECFDF5] text-[#065F46] text-[11px] font-bold px-2.5 py-1 rounded-full mb-2">✓ Fixed by: {p.fix}</span>
                    <p className="text-xs text-[#33405A]">{p.after}</p>
                    {p.shot && <img src="/instructions/fairness-table.png" alt="Fairness report table showing the Longest streak column, with several employees flagged over 6 days" className="w-full rounded border border-[#E4E7EC] mt-2" />}
                  </div>
                </div>
              ))}
            </div>

            <div className="bg-white rounded-lg border border-[#E4E7EC] p-4">
              <div className="text-sm font-semibold mb-1">Reading the Fairness Report</div>
              <p className="text-xs text-[#64748B] mb-3">One row per employee. Here's what each column is actually telling you.</p>
              <dl className="text-xs">
                {[
                  ["Total", "How many shifts they worked this rotation, all in."],
                  ["Off", "Days they were simply not scheduled — no PTO, no shift, just off."],
                  ["PTO-1", "Approved time off. Hard rule — never scheduled."],
                  ["PTO-2 ✓ / *", "Requested (not guaranteed) time off. ✓ = it was honored. * = they had to be called in anyway."],
                  ["Weekends ⚠", "How many weekend/holiday shifts they worked. The ⚠ means they went over 4 weeks without one — an uneven gap."],
                  ["Longest streak ⚠", "Their longest run of consecutive working days. The ⚠ means it went over your Max consecutive days setting."],
                  ["Missing shifts ⚠", "Shift types they never got assigned at all this rotation, even once."],
                  ["Per-shift columns", "How many times they worked each specific shift — use this to spot someone stuck doing the same one repeatedly."],
                  ["Distribution", "A tiny bar chart of their shift mix at a glance — evenly spread bars = a well-balanced schedule for that person."],
                ].map(([term, def]) => (
                  <div key={term} className="flex gap-4 py-1.5 border-t border-[#F1F5F9] first:border-t-0">
                    <dt className="font-bold w-40 flex-none">{term}</dt>
                    <dd className="text-[#33405A]">{def}</dd>
                  </div>
                ))}
              </dl>
              <div className="bg-[#FEF3C7] border border-[#FDE68A] text-[#92400E] text-xs rounded px-3 py-2 mt-3">
                💡 Quickest way to judge a schedule: look at the "Overall balance" banner at the top of this tab first. Only dig into individual rows if it says anything other than "Excellent."
              </div>
            </div>
          </div>
        )}

        {tab === "setup" && (
          <div className="space-y-4">
            <div className="bg-white rounded-lg border border-[#E4E7EC] p-4 flex flex-wrap gap-6 items-end">
              <div>
                <label className="block text-xs font-semibold text-[#64748B] mb-1">Rotation length</label>
                <select value={numWeeks} onChange={(e) => setNumWeeks(Number(e.target.value))} className="border border-[#E4E7EC] rounded px-3 py-1.5 text-sm">
                  {[2, 4, 6, 8].map((w) => <option key={w} value={w}>{w} weeks</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-[#64748B] mb-1">Start date (auto-set to next Monday)</label>
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="border border-[#E4E7EC] rounded px-3 py-1.5 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-[#64748B] mb-1">Max consecutive days</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number" min={1} value={maxConsecutiveDays}
                    onChange={(e) => setMaxConsecutiveDays(Math.max(0, Number(e.target.value) || 0))}
                    className="w-16 border border-[#E4E7EC] rounded px-2 py-1.5 text-sm text-center"
                  />
                  <label className="flex items-center gap-1 text-[11px] text-[#64748B] cursor-pointer" title="Soft: the optimizer tries to avoid long streaks but won't leave a shift unfilled just to prevent one. Hard: never exceeded — may leave a hole for PRN to cover instead.">
                    <input type="checkbox" checked={consecutiveHardLimit} onChange={(e) => setConsecutiveHardLimit(e.target.checked)} />
                    Hard limit
                  </label>
                </div>
              </div>
              <div className="flex-1" />
              {permanent.length === 0 && (
                <p className="text-xs text-[#DC2626] mr-2">Add at least one permanent employee (Permanent Staff tab) before generating.</p>
              )}
              <button onClick={generate} disabled={generating || permanent.length === 0} className="px-5 py-2 text-sm font-semibold rounded bg-[#0D9488] text-white hover:bg-[#0B6B62] disabled:opacity-50">
                {generating ? "Matching + optimizing…" : "Generate schedule →"}
              </button>
            </div>

            <div className="bg-white rounded-lg border border-[#E4E7EC] p-4">
              <div className="text-sm font-semibold mb-1">Feasibility check</div>
              <p className="text-xs text-[#64748B] mb-3">
                Estimated capacity for the current roster, PTO, and rotation settings — updates live, before you generate.
                This can prove you're short-staffed; it can't guarantee zero coverage gaps (day-specific clustering can still produce holes generation would catch).
              </p>
              <div className="flex flex-wrap gap-4 mb-3">
                <div className="px-3 py-2 rounded border border-[#E4E7EC]">
                  <div className="text-[10px] text-[#64748B] uppercase tracking-wide">Required shifts</div>
                  <div className="text-lg font-bold">{feasibility.overall.requiredSlots}</div>
                </div>
                <div className="px-3 py-2 rounded border border-[#E4E7EC]">
                  <div className="text-[10px] text-[#64748B] uppercase tracking-wide">Available (permanent + PRN)</div>
                  <div className="text-lg font-bold">{feasibility.overall.availablePermanentSlots} + {feasibility.overall.availablePrnSlots} = {feasibility.overall.totalAvailable}</div>
                </div>
                <div className={`px-3 py-2 rounded border ${feasibility.overall.shortfall > 0 ? "border-[#DC2626] bg-[#FEE2E2]" : "border-[#A7F3D0] bg-[#ECFDF5]"}`}>
                  <div className="text-[10px] text-[#64748B] uppercase tracking-wide">Shortfall</div>
                  <div className={`text-lg font-bold ${feasibility.overall.shortfall > 0 ? "text-[#DC2626]" : "text-[#0D9488]"}`}>{feasibility.overall.shortfall}</div>
                </div>
              </div>
              {feasibility.weekends.some((w) => w.shortfall > 0) && (
                <div className="mb-3">
                  <div className="text-xs font-semibold mb-1 text-[#DC2626]">⚠ Weekends short on permanent coverage</div>
                  <table className="text-xs border-collapse">
                    <thead>
                      <tr className="text-[#64748B]">
                        <th className="text-left pr-4 py-1">Weekend</th>
                        <th className="text-right pr-4 py-1">Required</th>
                        <th className="text-right pr-4 py-1">Available</th>
                        <th className="text-right py-1">Short</th>
                      </tr>
                    </thead>
                    <tbody>
                      {feasibility.weekends.filter((w) => w.shortfall > 0).map((w) => (
                        <tr key={w.satIso} className="border-t border-[#F1F5F9]">
                          <td className="pr-4 py-1">{w.satLabel} – {w.sunLabel}</td>
                          <td className="text-right pr-4 py-1">{w.required}</td>
                          <td className="text-right pr-4 py-1">{w.availablePermanent}</td>
                          <td className="text-right py-1 text-[#DC2626] font-semibold">{w.shortfall}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {feasibility.holidays.some((h) => h.shortfall > 0) && (
                <div>
                  <div className="text-xs font-semibold mb-1 text-[#DC2626]">⚠ Holidays short on coverage</div>
                  <table className="text-xs border-collapse">
                    <thead>
                      <tr className="text-[#64748B]">
                        <th className="text-left pr-4 py-1">Holiday</th>
                        <th className="text-right pr-4 py-1">Required</th>
                        <th className="text-right pr-4 py-1">Available (perm + PRN)</th>
                        <th className="text-right py-1">Short</th>
                      </tr>
                    </thead>
                    <tbody>
                      {feasibility.holidays.filter((h) => h.shortfall > 0).map((h) => (
                        <tr key={h.iso} className="border-t border-[#F1F5F9]">
                          <td className="pr-4 py-1">{h.label}</td>
                          <td className="text-right pr-4 py-1">{h.required}</td>
                          <td className="text-right pr-4 py-1">{h.availablePermanent} + {h.availablePrn}</td>
                          <td className="text-right py-1 text-[#DC2626] font-semibold">{h.shortfall}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {feasibility.overall.shortfall === 0 && !feasibility.weekends.some((w) => w.shortfall > 0) && !feasibility.holidays.some((h) => h.shortfall > 0) && (
                <div className="text-xs text-[#0D9488] font-semibold">✓ No capacity shortfall detected for this rotation.</div>
              )}
            </div>

            <div className="bg-white rounded-lg border border-[#E4E7EC] p-4">
              <div className="text-sm font-semibold mb-1">Manage shifts</div>
              <p className="text-xs text-[#64748B] mb-3">
                Your own shift roster — add as many as you need, rename any (up to 4 characters so it still fits the schedule grid), and mark which ones run on weekends/holidays.
                "Continuity" means once assigned, an employee must work it for a run of consecutive days in that range — never more, never less. "Paused" temporarily removes a shift
                from the rotation without deleting it (pick up to 2).
              </p>
              <div className="bg-[#FEF3C7] border border-[#FDE68A] text-[#92400E] text-xs rounded px-3 py-2 mb-3">
                ⚠ <b>Continuity range — use one of these:</b> 2–3, 2–4, 2–5, or 1–3. <b>Avoid:</b> 3–3, 3–4, 3–5, 4–4, 4–5 (can leave a shift unfilled with no warning).
              </div>
              <div className="overflow-x-auto">
                <table className="text-xs border-collapse w-full">
                  <thead>
                    <tr className="text-[#64748B] text-left">
                      <th className="pr-3 py-1">Code</th>
                      <th className="pr-3 py-1">Name</th>
                      <th className="pr-3 py-1 text-center">Weekend/<br />holiday?</th>
                      <th className="pr-3 py-1 text-center">Continuity?</th>
                      <th className="pr-3 py-1 text-center">Days</th>
                      <th className="pr-3 py-1 text-center">Paused?</th>
                      <th className="py-1"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {shiftDefsSorted.map((d) => (
                      <tr key={d.code} className="border-t border-[#F1F5F9]">
                        <td className="pr-3 py-1.5 font-mono text-[#64748B]">{d.code}</td>
                        <td className="pr-3 py-1.5">
                          <input
                            value={d.label || ""}
                            onChange={(e) => renameShift(d.code, e.target.value)}
                            placeholder={d.code}
                            maxLength={4}
                            className="w-16 border border-[#E4E7EC] rounded px-2 py-1 text-xs font-mono uppercase text-center"
                          />
                        </td>
                        <td className="pr-3 py-1.5 text-center">
                          <input type="checkbox" checked={d.activeWeekend} onChange={() => toggleShiftWeekend(d.code)} />
                        </td>
                        <td className="pr-3 py-1.5 text-center">
                          <input type="checkbox" checked={d.continuityMin != null} onChange={(e) => setShiftContinuity(d.code, e.target.checked)} />
                        </td>
                        <td className="pr-3 py-1.5 text-center">
                          {d.continuityMin != null ? (
                            <span className="flex items-center justify-center gap-1">
                              <input type="number" min={1} value={d.continuityMin} onChange={(e) => setShiftContinuityDays(d.code, "continuityMin", e.target.value)} className="w-10 border border-[#E4E7EC] rounded px-1 py-0.5 text-center" />
                              –
                              <input type="number" min={1} value={d.continuityMax} onChange={(e) => setShiftContinuityDays(d.code, "continuityMax", e.target.value)} className="w-10 border border-[#E4E7EC] rounded px-1 py-0.5 text-center" />
                            </span>
                          ) : <span className="text-[#64748B]">—</span>}
                        </td>
                        <td className="pr-3 py-1.5 text-center">
                          <input
                            type="checkbox" checked={d.collapsed}
                            disabled={!d.collapsed && shiftDefsSorted.filter((x) => x.collapsed).length >= 2}
                            onChange={() => toggleShiftCollapse(d.code)}
                          />
                        </td>
                        <td className="py-1.5">
                          <button onClick={() => removeShiftDefinition(d.code)} className="text-[#DC2626] text-[10px]">Remove</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button onClick={addShiftDefinition} className="mt-3 px-3 py-1.5 text-xs rounded border border-[#0D9488] text-[#0D9488] hover:bg-[#0D9488] hover:text-white">+ Add shift</button>
            </div>

            <div className="bg-white rounded-lg border border-[#E4E7EC] p-4">
              <div className="text-sm font-semibold mb-2">Holidays</div>
              <p className="text-xs text-[#64748B] mb-2">Holiday dates use the weekend/holiday shift set, even on a weekday.</p>
              <div className="flex gap-2 items-center mb-2">
                <input type="date" value={holidayInput} onChange={(e) => setHolidayInput(e.target.value)} className="border border-[#E4E7EC] rounded px-3 py-1.5 text-sm" />
                <button onClick={addHoliday} className="px-3 py-1.5 text-xs rounded border border-[#E4E7EC] hover:bg-[#F7F8FA]">Add holiday</button>
              </div>
              <div className="flex flex-wrap gap-2">
                {[...holidays].map((iso) => (
                  <span key={iso} className="text-xs bg-[#FEF3C7] text-[#92400E] rounded px-2 py-1 flex items-center gap-1">{iso} <button onClick={() => removeHoliday(iso)} className="hover:text-[#DC2626]">✕</button></span>
                ))}
              </div>
            </div>

            <div className="bg-[#EFF6FF] border border-[#BFDBFE] text-[#1E3A8A] text-xs rounded px-3 py-2">
              🔧 Every manager has their own shift roster, weekend set, and continuity rules. Use "Manage shifts" above to add, remove, rename, or reconfigure them for your own team.
            </div>
          </div>
        )}

        {tab === "permanent" && (
          <div className="space-y-4">
            <div className="bg-white rounded-lg border border-[#E4E7EC] p-4">
              <div className="text-sm font-semibold mb-1">Fixed work days</div>
              <p className="text-xs text-[#64748B] mb-3">Toggle the weekdays an employee always works. Their shift code still rotates fairly — only the day is locked.</p>
              <div className="flex flex-wrap items-end gap-3 mb-4 pb-4 border-b border-[#F1F5F9]">
                <div>
                  <label className="block text-xs font-semibold text-[#64748B] mb-1">Leave/block start</label>
                  <input type="date" value={leaveStart} onChange={(e) => setLeaveStart(e.target.value)} className="border border-[#E4E7EC] rounded px-3 py-1.5 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-[#64748B] mb-1">Leave/block end</label>
                  <input type="date" value={leaveEnd} onChange={(e) => setLeaveEnd(e.target.value)} className="border border-[#E4E7EC] rounded px-3 py-1.5 text-sm" />
                </div>
                <p className="text-xs text-[#64748B] max-w-sm">Set a range, then use "Block" on an employee below to mark them fully unavailable for that whole span (e.g. medical leave) — a hard rule, same as PTO-1. "Clear" undoes it.</p>
              </div>
              <div className="flex flex-wrap items-end gap-3 mb-4 pb-4 border-b border-[#F1F5F9]">
                <div>
                  <label className="block text-xs font-semibold text-[#64748B] mb-1">Add employee</label>
                  <input
                    value={newPermanentName}
                    onChange={(e) => setNewPermanentName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addPermanent()}
                    placeholder="Employee name"
                    className="border border-[#E4E7EC] rounded px-3 py-1.5 text-sm w-48"
                  />
                </div>
                <button onClick={addPermanent} disabled={!newPermanentName.trim()} className="px-4 py-1.5 text-sm rounded bg-[#0D9488] text-white hover:bg-[#0B6B62] disabled:opacity-50">Add employee</button>
                <p className="text-xs text-[#64748B] max-w-sm">Team size isn't fixed — add or remove as many permanent employees as your roster needs.</p>
              </div>
              {permanent.length === 0 && (
                <div className="text-sm text-[#64748B] py-6 text-center">No permanent employees yet — add your first one above.</div>
              )}
              <div className="space-y-3">
                {permanent.map((emp) => (
                  <div key={emp.id} className="flex flex-col gap-1.5 pb-3 border-b border-[#F1F5F9] last:border-b-0 last:pb-0">
                    <div className="flex items-center gap-3 flex-wrap">
                      <input value={emp.name} onChange={(e) => setEmployees((prev) => prev.map((p) => (p.id === emp.id ? { ...p, name: e.target.value } : p)))} onBlur={() => upsertEmployee(emp, viewingOwnerId).catch(reportSyncError)} className="text-sm border border-[#E4E7EC] rounded px-2 py-1 w-32" />
                      <div className="flex gap-1">
                        {DOW.map((d, dow) => {
                          const active = emp.fixedDays.includes(dow);
                          return <button key={dow} onClick={() => toggleFixedDay(emp.id, dow)} className={`w-8 h-7 text-[10px] rounded border ${active ? "bg-[#0D9488] text-white border-[#0D9488]" : "border-[#E4E7EC] text-[#64748B]"}`}>{d[0]}</button>;
                        })}
                      </div>
                      <button onClick={() => blockLeave(emp.id)} disabled={!leaveStart || !leaveEnd} className="ml-auto px-2 py-1 text-[10px] rounded border border-[#DC2626] text-[#DC2626] hover:bg-[#DC2626] hover:text-white disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[#DC2626]">Block leave</button>
                      <button onClick={() => clearLeave(emp.id)} disabled={!leaveStart || !leaveEnd} className="px-2 py-1 text-[10px] rounded border border-[#E4E7EC] text-[#64748B] hover:bg-[#F7F8FA] disabled:opacity-30">Clear</button>
                      <button onClick={() => removeEmployee(emp)} className="px-2 py-1 text-[10px] text-[#DC2626]">Remove</button>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap pl-1">
                      <label className="flex items-center gap-1.5 text-[11px] text-[#64748B] cursor-pointer">
                        <input
                          type="checkbox"
                          checked={!!emp.shiftCap}
                          onChange={(e) => setEmployeeShiftCap(emp.id, e.target.checked ? { windowDays: 14, maxShifts: 7 } : null)}
                        />
                        Extended-hour schedule (caps shifts per period)
                      </label>
                      {emp.shiftCap && (
                        <span className="flex items-center gap-1 text-[11px] text-[#64748B]">
                          max
                          <input
                            type="number" min={1} value={emp.shiftCap.maxShifts}
                            onChange={(e) => setEmployeeShiftCap(emp.id, { ...emp.shiftCap, maxShifts: Math.max(1, Number(e.target.value) || 1) })}
                            className="w-12 border border-[#E4E7EC] rounded px-1 py-0.5 text-center"
                          />
                          shifts per
                          <input
                            type="number" min={1} value={emp.shiftCap.windowDays}
                            onChange={(e) => setEmployeeShiftCap(emp.id, { ...emp.shiftCap, windowDays: Math.max(1, Number(e.target.value) || 1) })}
                            className="w-12 border border-[#E4E7EC] rounded px-1 py-0.5 text-center"
                          />
                          days
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap pl-1">
                      <label className="text-[11px] text-[#64748B]">Weekend rotation:</label>
                      <select
                        value={emp.weekendRotation ? emp.weekendRotation.cycleWeekends : "off"}
                        onChange={(e) => {
                          const v = e.target.value;
                          setEmployeeWeekendRotation(emp.id, v === "off" ? null : { cycleWeekends: Number(v), openOffset: 0 });
                        }}
                        className="border border-[#E4E7EC] rounded px-2 py-1 text-[11px]"
                      >
                        <option value="off">No rotation (works every weekend, or already covered elsewhere)</option>
                        <option value="2">Every other weekend</option>
                        <option value="4">One weekend per month (default)</option>
                      </select>
                      {emp.weekendRotation && emp.weekendRotation.cycleWeekends > 1 && (
                        <span className="flex items-center gap-1 text-[11px] text-[#64748B]">
                          group
                          <select
                            value={emp.weekendRotation.openOffset}
                            onChange={(e) => setEmployeeWeekendRotation(emp.id, { ...emp.weekendRotation, openOffset: Number(e.target.value) })}
                            className="border border-[#E4E7EC] rounded px-1 py-0.5 text-[11px]"
                          >
                            {Array.from({ length: emp.weekendRotation.cycleWeekends }, (_, i) => (
                              <option key={i} value={i}>{i + 1} of {emp.weekendRotation.cycleWeekends}</option>
                            ))}
                          </select>
                        </span>
                      )}
                      {emp.shiftCap && emp.fixedDays.length > 0 && !emp.fixedDays.some((d) => d === 0 || d === 6) && (
                        <span className="text-[11px] text-[#7C3AED]">
                          Fixed days + hour cap already rule out weekends for this employee — rotation setting above has no effect either way.
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-[#EFF6FF] border border-[#BFDBFE] text-[#1E3A8A] text-xs rounded px-3 py-2 flex flex-wrap items-center gap-3">
              <span>Applies each employee's weekend rotation above to the Saturdays/Sundays currently in view — hard-blocks (PTO-1) the ones their cycle says they're off, leaves the rest untouched. Safe to re-run after changing a rotation, the date range, or adding staff; manual PTO edits are never overwritten.</span>
              <button onClick={applyWeekendRotation} className="ml-auto px-3 py-1.5 text-xs font-semibold rounded bg-[#0D9488] text-white hover:bg-[#0B6B62] whitespace-nowrap">Apply weekend rotation</button>
            </div>

            <div className="bg-white rounded-lg border border-[#E4E7EC] overflow-hidden">
              <div className="px-4 py-3 border-b border-[#E4E7EC]">
                <div className="text-sm font-semibold">PTO — click a cell to cycle: available → PTO-1 (hard) → PTO-2 (soft) → available</div>
                <div className="flex gap-4 mt-2 text-xs">
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm inline-block bg-[#DC2626]" />PTO-1: honored no matter what</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm inline-block bg-[#F59E0B]" />PTO-2: honored unless the schedule can't cover without them</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm inline-block bg-[#DC2626]" style={{ border: "2px dashed #7C3AED" }} />dashed border = auto-set by weekend rotation</span>
                  <span className="text-[#DC2626]">HOL = holiday — assign coverage manually here, same as any other day</span>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="text-xs border-collapse">
                  <thead>
                    <tr>
                      <th className="sticky left-0 bg-white z-10 text-left px-3 py-2 border-b border-[#E4E7EC] min-w-[140px]">Employee</th>
                      {days.map((d) => (
                        <th key={d.idx} className={`px-1 py-2 border-b border-[#E4E7EC] font-normal text-center min-w-[30px] ${d.isWeekend ? "bg-[#F1F5F9]" : ""}`}>
                          <div className="text-[#64748B]">{d.wd[0]}</div><div className="text-[10px]">{d.md}</div>
                          {holidays.has(d.iso) && <div className="text-[9px] text-[#DC2626]">HOL</div>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {permanent.map((emp) => (
                      <tr key={emp.id}>
                        <td className="sticky left-0 bg-white z-10 px-3 py-1 border-b border-[#F1F5F9] font-medium">{emp.name}</td>
                        {days.map((d) => {
                          const k = key(emp.id, d.idx);
                          const st = ptoStatus[k];
                          const autoGenerated = ptoSource[k] === "weekend_rotation";
                          return (
                            <td key={d.idx} className="border-b border-[#F1F5F9] p-0.5">
                              <button
                                onClick={() => cyclePto(emp.id, d.idx)}
                                title={autoGenerated ? "Auto-set by weekend rotation — click to override" : undefined}
                                className="w-6 h-6 rounded-sm"
                                style={{
                                  background: st === "PTO1" ? "#DC2626" : st === "PTO2" ? "#F59E0B" : d.isWeekend ? "#F1F5F9" : "#F8FAFC",
                                  border: autoGenerated ? "2px dashed #7C3AED" : "1px solid #E4E7EC",
                                }}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {tab === "extra" && (
          <div className="space-y-4">
            <div className="bg-white rounded-lg border border-[#E4E7EC] p-4">
              <div className="text-sm font-semibold mb-2">Add PRN / as-needed staff</div>
              <div className="flex flex-wrap gap-3 items-end mb-3">
                <div>
                  <label className="block text-xs font-semibold text-[#64748B] mb-1">Name</label>
                  <input value={newExtraName} onChange={(e) => setNewExtraName(e.target.value)} className="border border-[#E4E7EC] rounded px-3 py-1.5 text-sm" />
                </div>
                <button onClick={addExtra} className="px-4 py-1.5 text-sm rounded bg-[#0D9488] text-white hover:bg-[#0B6B62]">Add staff member</button>
              </div>
              <div className="text-xs font-semibold text-[#64748B] mb-1">Trained on (locks which shifts they can fill):</div>
              <div className="flex flex-wrap gap-2">
                {ALL_SHIFT_CODES.map((s) => {
                  const active = newExtraShifts.includes(s);
                  return (
                    <button key={s} onClick={() => setNewExtraShifts((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))}
                      className="px-3 py-1 rounded text-xs font-mono font-semibold border"
                      style={active ? { background: getShiftColor(s), borderColor: getShiftColor(s), color: "#fff" } : { borderColor: "#E4E7EC" }}>{shiftLabel(s)}</button>
                  );
                })}
              </div>
            </div>

            {extra.length > 0 && (
              <div className="bg-white rounded-lg border border-[#E4E7EC] p-4">
                <div className="text-sm font-semibold mb-2">PRN roster</div>
                <div className="space-y-2">
                  {extra.map((e) => (
                    <div key={e.id} className="flex items-center gap-3 flex-wrap text-sm border-b border-[#F1F5F9] pb-2">
                      <span className="font-medium w-32">{e.name}</span>
                      <span className="text-xs text-[#64748B]">Trained: {e.allowedShifts.map(shiftLabel).join(", ")}</span>
                      <button onClick={() => convertToPermanent(e.id)} className="ml-auto px-3 py-1 text-xs rounded border border-[#0D9488] text-[#0D9488] hover:bg-[#0D9488] hover:text-white">Convert to permanent →</button>
                      <button onClick={() => removeEmployee(e)} className="px-2 py-1 text-xs text-[#DC2626]">Remove</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {extra.length > 0 && (
              <div className="bg-white rounded-lg border border-[#E4E7EC] overflow-hidden">
                <div className="px-4 py-3 border-b border-[#E4E7EC] text-sm font-semibold">Locked availability — click to mark a day they CAN work (default: unavailable)</div>
                <div className="overflow-x-auto">
                  <table className="text-xs border-collapse">
                    <thead>
                      <tr>
                        <th className="sticky left-0 bg-white z-10 text-left px-3 py-2 border-b border-[#E4E7EC] min-w-[140px]">Employee</th>
                        {days.map((d) => (
                          <th key={d.idx} className={`px-1 py-2 border-b border-[#E4E7EC] font-normal text-center min-w-[30px] ${d.isWeekend ? "bg-[#F1F5F9]" : ""}`}>
                            <div className="text-[#64748B]">{d.wd[0]}</div><div className="text-[10px]">{d.md}</div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {extra.map((emp) => (
                        <tr key={emp.id}>
                          <td className="sticky left-0 bg-white z-10 px-3 py-1 border-b border-[#F1F5F9] font-medium">{emp.name}</td>
                          {days.map((d) => {
                            const avail = extraAvailable[key(emp.id, d.idx)];
                            return (
                              <td key={d.idx} className="border-b border-[#F1F5F9] p-0.5">
                                <button onClick={() => toggleExtraAvail(emp.id, d.idx)} className="w-6 h-6 rounded-sm" style={{ background: avail ? "#86EFAC" : "#F1F5F9", border: "1px solid #E4E7EC" }} />
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "schedule" && schedule && (
          <div className="space-y-3">
            <div className="bg-[#ECFDF5] border border-[#A7F3D0] text-[#065F46] text-xs rounded px-3 py-2 flex flex-wrap gap-4">
              <span>Fairness score before optimizer: <b>{schedule.costBefore.toFixed(1)}</b></span>
              <span>→ after {schedule.iterations.toLocaleString()} passes: <b>{schedule.costAfter.toFixed(1)}</b></span>
              <span>({schedule.costBefore > 0 ? Math.round((1 - schedule.costAfter / schedule.costBefore) * 100) : 0}% improvement)</span>
            </div>
            {schedule.totalHoles > 0 && (
              <div className="bg-[#FEE2E2] border-2 border-[#DC2626] text-[#991B1B] text-sm rounded px-3 py-2 font-semibold">
                ⚠ {schedule.totalHoles} shift(s) are mathematically unfillable given current staff, PTO, and qualifications — see red "HOLE" cells below.
              </div>
            )}
            {schedule.totalOverrides > 0 && (
              <div className="bg-[#FEF3C7] border border-[#FDE68A] text-[#92400E] text-sm rounded px-3 py-2">
                ℹ {schedule.totalOverrides} shift(s) had to pull someone off their requested PTO-2 day (marked with *).
              </div>
            )}
            {schedule.continuityCheck.violations.length > 0 && (
              <div className="bg-[#FEE2E2] border-2 border-[#DC2626] text-[#991B1B] text-sm rounded px-3 py-2 font-semibold">
                ⚠ Continuity rule violations detected: {schedule.continuityCheck.violations.join("; ")}
              </div>
            )}
            {schedule.shiftCapViolations.length > 0 && (
              <div className="bg-[#FEE2E2] border-2 border-[#DC2626] text-[#991B1B] text-sm rounded px-3 py-2 font-semibold">
                ⚠ Shift-cap violations detected: {schedule.shiftCapViolations.join("; ")}
              </div>
            )}
            {schedule.cappedFixedDayViolations.length > 0 && (
              <div className="bg-[#FEE2E2] border-2 border-[#DC2626] text-[#991B1B] text-sm rounded px-3 py-2 font-semibold">
                ⚠ Fixed-day violations detected: {schedule.cappedFixedDayViolations.join("; ")}
              </div>
            )}
            {schedule.employeesMissingShifts > 0 && (
              <div className="bg-[#FEF3C7] border border-[#FDE68A] text-[#92400E] text-sm rounded px-3 py-2">
                ℹ {schedule.employeesMissingShifts} employee(s) didn't get at least one of every active shift type this rotation — see Fairness Report for details.
              </div>
            )}
            <div className="flex items-center gap-3 flex-wrap text-xs">
              <div className="text-[#64748B]">Legend:</div>
              {ALL_SHIFT_CODES.map((s) => <div key={s} className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm inline-block" style={{ background: getShiftColor(s) }} />{shiftLabel(s)}{isContinuityCode(s) ? "†" : ""}</div>)}
              <div className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm inline-block bg-[#E4E7EC]" />OFF</div>
              <div className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm inline-block bg-[#DC2626]" />PTO-1</div>
              <div className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm inline-block bg-[#F59E0B]" />PTO-2</div>
              <button
                onClick={() => downloadScheduleCsv({ schedule, permanent, extra, ptoStatus, holidays, key, shiftLabel }, `schedule_${startDate}_${numWeeks}w.csv`)}
                className="ml-auto px-3 py-1.5 text-xs font-semibold rounded border border-[#0D9488] text-[#0D9488] hover:bg-[#0D9488] hover:text-white"
              >
                ⬇ Export CSV
              </button>
              <button onClick={generate} disabled={generating} className="px-3 py-1.5 text-xs font-semibold rounded bg-[#0D9488] text-white hover:bg-[#0B6B62] disabled:opacity-50">
                {generating ? "Working…" : "↻ Regenerate"}
              </button>
            </div>
            {renderScheduleTable(permanent, "Permanent staff")}
            {extra.length > 0 && renderScheduleTable(extra, "PRN / as-needed staff")}
          </div>
        )}

        {tab === "fairness" && schedule && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-white rounded-lg border border-[#E4E7EC] p-4">
                <div className="text-xs text-[#64748B] mb-1">Overall balance</div>
                <div className="text-lg font-bold" style={{ color: summary.tone }}>{summary.label}</div>
              </div>
              <div className="bg-white rounded-lg border border-[#E4E7EC] p-4">
                <div className="text-xs text-[#64748B] mb-1">Total shift-count spread</div>
                <div className="text-lg font-bold">{summary.totalSpread}</div>
              </div>
              <div className="bg-white rounded-lg border border-[#E4E7EC] p-4">
                <div className="text-xs text-[#64748B] mb-1">Unfilled shifts</div>
                <div className="text-lg font-bold text-[#DC2626]">{schedule.totalHoles}</div>
              </div>
              <div className="bg-white rounded-lg border border-[#E4E7EC] p-4">
                <div className="text-xs text-[#64748B] mb-1">PTO-2 overrides</div>
                <div className="text-lg font-bold text-[#CA8A04]">{schedule.totalOverrides}</div>
              </div>
            </div>

            <div className="bg-white rounded-lg border border-[#E4E7EC] p-4">
              <div className="text-sm font-semibold mb-2">Continuity rule check</div>
              {Object.entries(continuityRules).map(([code, rule]) => {
                const runs = schedule.continuityCheck.runsByCode[code] || [];
                const counts = {};
                runs.forEach((len) => { counts[len] = (counts[len] || 0) + 1; });
                const ok = runs.every((len) => len >= rule.minDays && len <= rule.maxDays);
                return (
                  <div key={code} className="text-xs mb-1 flex items-center gap-2">
                    <span className="font-mono font-semibold px-2 py-0.5 rounded text-white" style={{ background: getShiftColor(code) }}>{shiftLabel(code)}</span>
                    <span>{rule.minDays}-{rule.maxDays} day blocks: {Object.entries(counts).map(([len, n]) => `${n}×${len}day`).join(", ") || "none assigned"}</span>
                    <span className={ok ? "text-[#0D9488] font-semibold" : "text-[#DC2626] font-semibold"}>{ok ? "✓ verified" : "⚠ violation"}</span>
                  </div>
                );
              })}
            </div>

            <div className="bg-white rounded-lg border border-[#E4E7EC] overflow-x-auto">
              <table className="text-xs border-collapse w-full">
                <thead>
                  <tr className="bg-[#F7F8FA]">
                    <th className="text-left px-3 py-2 border-b border-[#E4E7EC]">Employee</th>
                    <th className="px-2 py-2 border-b border-[#E4E7EC]">Total</th>
                    <th className="px-2 py-2 border-b border-[#E4E7EC]">Off</th>
                    <th className="px-2 py-2 border-b border-[#E4E7EC]">PTO-1</th>
                    <th className="px-2 py-2 border-b border-[#E4E7EC]">PTO-2 ✓</th>
                    <th className="px-2 py-2 border-b border-[#E4E7EC]">PTO-2 *</th>
                    <th className="px-2 py-2 border-b border-[#E4E7EC]">Weekends</th>
                    <th className="px-2 py-2 border-b border-[#E4E7EC]">Longest streak</th>
                    <th className="px-2 py-2 border-b border-[#E4E7EC]">Missing shifts</th>
                    {ALL_SHIFT_CODES.map((s) => <th key={s} className="px-2 py-2 border-b border-[#E4E7EC]" title={s}>{shiftLabel(s)}</th>)}
                    <th className="px-3 py-2 border-b border-[#E4E7EC] text-left">Distribution</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.fairness.map((f) => {
                    const max = Math.max(...ALL_SHIFT_CODES.map((s) => f.perShift[s]), 1);
                    return (
                      <tr key={f.id}>
                        <td className="px-3 py-1.5 border-b border-[#F1F5F9] font-medium">
                          {f.name}{f.fixedDays.length > 0 && <span className="text-[9px] text-[#0D9488] ml-1">(fixed {f.fixedDays.map((d) => DOW[d]).join("/")})</span>}{f.shiftCap && <span className="text-[9px] text-[#7C3AED] ml-1">(cap {f.shiftCap.maxShifts}/{f.shiftCap.windowDays}d)</span>}
                        </td>
                        <td className="px-2 py-1.5 border-b border-[#F1F5F9] text-center font-semibold">{f.total}</td>
                        <td className="px-2 py-1.5 border-b border-[#F1F5F9] text-center text-[#64748B]">{f.offDays}</td>
                        <td className="px-2 py-1.5 border-b border-[#F1F5F9] text-center text-[#64748B]">{f.pto1Days}</td>
                        <td className="px-2 py-1.5 border-b border-[#F1F5F9] text-center text-[#64748B]">{f.pto2Honored}</td>
                        <td className="px-2 py-1.5 border-b border-[#F1F5F9] text-center text-[#CA8A04]">{f.pto2Overridden}</td>
                        <td className="px-2 py-1.5 border-b border-[#F1F5F9] text-center">{f.weekendCount}{f.weekendRuleBroken && <span title="Gap exceeded 4 weeks" className="text-[#DC2626] ml-1">⚠</span>}</td>
                        <td className="px-2 py-1.5 border-b border-[#F1F5F9] text-center">{f.longestRun} day{f.longestRun === 1 ? "" : "s"}{f.longestRunExceeded && <span title={`Worked ${f.longestRun} days in a row — over your ${maxConsecutiveDays}-day preference`} className="text-[#DC2626] ml-1">⚠</span>}</td>
                        <td className="px-2 py-1.5 border-b border-[#F1F5F9] text-center">
                          {f.missingShifts.length > 0
                            ? <span className="text-[#DC2626] font-semibold" title={`Never worked: ${f.missingShifts.map(shiftLabel).join(", ")}`}>⚠ {f.missingShifts.map(shiftLabel).join(", ")}</span>
                            : <span className="text-[#0D9488]">✓</span>}
                        </td>
                        {ALL_SHIFT_CODES.map((s) => <td key={s} className={`px-2 py-1.5 border-b border-[#F1F5F9] text-center ${f.missingShifts.includes(s) ? "text-[#DC2626] font-semibold" : ""}`}>{f.perShift[s]}</td>)}
                        <td className="px-3 py-1.5 border-b border-[#F1F5F9]">
                          <div className="flex items-end gap-0.5 h-6">
                            {ALL_SHIFT_CODES.map((s) => <div key={s} title={`${shiftLabel(s)}: ${f.perShift[s]}`} style={{ background: getShiftColor(s), height: `${Math.max((f.perShift[s] / max) * 100, 12)}%`, width: "6px" }} className="rounded-sm" />)}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {schedule.extraFairness.length > 0 && (
              <div className="bg-white rounded-lg border border-[#E4E7EC] overflow-x-auto">
                <div className="px-4 py-2 border-b border-[#E4E7EC] text-sm font-semibold">PRN staff usage</div>
                <table className="text-xs border-collapse w-full">
                  <thead><tr className="bg-[#F7F8FA]"><th className="text-left px-3 py-2 border-b border-[#E4E7EC]">Name</th><th className="px-2 py-2 border-b border-[#E4E7EC]">Trained on</th><th className="px-2 py-2 border-b border-[#E4E7EC]">Shifts worked</th></tr></thead>
                  <tbody>
                    {schedule.extraFairness.map((f) => (
                      <tr key={f.id}><td className="px-3 py-1.5 border-b border-[#F1F5F9] font-medium">{f.name}</td><td className="px-2 py-1.5 border-b border-[#F1F5F9] text-center">{f.allowedShifts.map(shiftLabel).join(", ")}</td><td className="px-2 py-1.5 border-b border-[#F1F5F9] text-center font-semibold">{f.total}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-xs text-[#64748B]">⚠ next to Weekends = that employee went more than 4 weeks without a weekend/holiday shift. ⚠ next to Longest streak = they worked more days in a row than your consecutive-days preference below allows.</p>
          </div>
        )}
      </div>
    </div>
  );
}
