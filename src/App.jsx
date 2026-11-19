import React, { useState, useMemo, useEffect, useRef } from "react";
import {
  fetchEmployees,
  insertEmployee,
  upsertEmployee,
  deleteEmployee,
  deleteAllEmployeesOfType,
  fetchHolidays,
  addHolidayRow,
  removeHolidayRow,
  deleteAllHolidays,
  fetchPtoStatus,
  upsertPtoStatus,
  deletePtoStatus,
  bulkUpsertPtoStatus,
  bulkDeletePtoStatus,
  clearPtoStatusForDates,
  fetchAllPtoStatus,
  fetchForcedHolidayWork,
  bulkUpsertForcedHolidayWork,
  bulkDeleteForcedHolidayWork,
  fetchAllForcedHolidayWork,
  fetchPinnedShifts,
  upsertPinnedShift,
  deletePinnedShift,
  fetchAllPinnedShifts,
  bulkUpsertPinnedShifts,
  fetchExtraAvailability,
  addExtraAvailabilityRow,
  removeExtraAvailabilityRow,
  bulkUpsertExtraAvailability,
  bulkDeleteExtraAvailability,
  fetchAllExtraAvailability,
  saveScheduleSnapshot,
  fetchScheduleSnapshot,
  deleteScheduleSnapshot,
  fetchScheduleSlots,
  saveScheduleSlot,
  renameScheduleSlot,
  deleteScheduleSlot,
  fetchShiftDefinitions,
  insertShiftDefinitions,
  upsertShiftDefinition,
  deleteShiftDefinition,
  deleteAllShiftDefinitions,
} from "./lib/persistence";
import {
  toLocalISO, nextMonday, fmtLabel, key, shiftPref,
  wouldExceedShiftCap, maxShiftsInAnyPayPeriod, guaranteeTargetForBlock, workedDayIndicesFromSchedule, respectsFixedDayRestriction,
  weekendIndexFor, scheduleWeekendEpoch, isOpenWeekend, isAdjacentToOffWeekend, kuhnMatch, partitionRun,
  longestConsecutiveRun, wouldExceedConsecutiveDays, countLonelyDaysOff, countLonelyShifts, countBackToBackSameShift, unfilledShifts, codeRepeatGaps,
  OVERFLOW_CODE, isOverflowKey, overflowBaseCode, nextOverflowKey, pickOverflowDays, pickPhantomCushionSlot, pickPhantomPermanentSwap, pickPhantomAnySteal,
  pickForcedHolidayCode,
} from "./lib/schedulingCore";
import { buildFeasibilityReport } from "./lib/feasibility";
import { buildOptimizationTips } from "./lib/optimizationTips";
import OptimizationTab from "./OptimizationTab";
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
  { code: "E1", label: null, sortOrder: 0, activeWeekend: true, weekendOnly: false, collapsed: false, continuityMin: null, continuityMax: null },
  { code: "E2", label: null, sortOrder: 1, activeWeekend: true, weekendOnly: false, collapsed: false, continuityMin: null, continuityMax: null },
  { code: "E3", label: null, sortOrder: 2, activeWeekend: true, weekendOnly: false, collapsed: false, continuityMin: null, continuityMax: null },
  { code: "E4", label: null, sortOrder: 3, activeWeekend: true, weekendOnly: false, collapsed: false, continuityMin: null, continuityMax: null },
  { code: "E5", label: null, sortOrder: 4, activeWeekend: false, weekendOnly: false, collapsed: false, continuityMin: null, continuityMax: null },
  { code: "E6", label: null, sortOrder: 5, activeWeekend: false, weekendOnly: false, collapsed: false, continuityMin: null, continuityMax: null },
  { code: "E7", label: null, sortOrder: 6, activeWeekend: false, weekendOnly: false, collapsed: false, continuityMin: 2, continuityMax: 3 },
  { code: "E8", label: null, sortOrder: 7, activeWeekend: true, weekendOnly: false, collapsed: false, continuityMin: null, continuityMax: null },
  { code: "E9", label: null, sortOrder: 8, activeWeekend: false, weekendOnly: false, collapsed: false, continuityMin: null, continuityMax: null },
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
  const [groupDaysOff, setGroupDaysOff] = useState(true);
  const [avoidLonelyShifts, setAvoidLonelyShifts] = useState(true);
  const [weekendPairingEnabled, setWeekendPairingEnabled] = useState(true);
  const [extendOffWeekends, setExtendOffWeekends] = useState(false);
  // Shift code(s) a manager would rather hand someone a long week via —
  // usually a float role, lighter than their regular assignment. Used
  // only to pick which PRN shift gets displaced for a phantom
  // needs-coverage flag, when there's a choice of which one to take.
  const [cushionShiftCodes, setCushionShiftCodes] = useState([]);
  const [manualEditWarnings, setManualEditWarnings] = useState([]);
  // Cells that held a real shift before a manual drag and now sit empty
  // because a DIFFERENT employee ended up with that day instead, with
  // nothing handed back — i.e. that employee is now genuinely short one
  // shift, not just relocated. Session-only (reset on regenerate); a
  // cell clears itself the moment it holds a real assignment again.
  const [kickedOutCells, setKickedOutCells] = useState(() => new Set());
  // Set by "Scan for missing shifts" (see scanForMissingShifts) — the one
  // best empty day per employee per pay period they're short in, as of
  // the last time the button was clicked. A fresh click always replaces
  // this outright rather than accumulating; null means it's never been
  // run this session (no banner), [] means it ran and found nothing.
  const [missingShiftCells, setMissingShiftCells] = useState(() => new Set());
  const [missingShiftReport, setMissingShiftReport] = useState(null);
  // Local picker state for the always-available "Add overflow (E0)
  // coverage" tool — a day chosen first, then an employee, same
  // two-step shape as everything else, but not tied to any actual gap
  // (E0 is never a hole) so there's no list to drive it off of.
  const [overflowAssignDay, setOverflowAssignDay] = useState("");
  // Dismissed structural alert boxes at the top of the Schedule tab
  // (cap violations, unfillable shifts, etc.) — keyed by the alert's own
  // content (type + exact text), not just a boolean per type, so a
  // dismissal only ever hides THIS exact issue. If a regenerate or edit
  // changes what the violation actually says (different people, a
  // different count), the key no longer matches and it reappears on its
  // own — no explicit "did the underlying thing change" bookkeeping
  // needed. Still cleared outright on every generate() for a clean
  // slate, same as kickedOutCells/missingShiftCells.
  const [dismissedAlerts, setDismissedAlerts] = useState(() => new Set());
  const [employees, setEmployees] = useState([]);
  const [ptoStatus, setPtoStatus] = useState({});
  const [ptoSource, setPtoSource] = useState({}); // key -> 'manual' | 'weekend_rotation'
  const [forcedHolidayWork, setForcedHolidayWork] = useState({}); // key -> true, the opposite of PTO: must be scheduled a real shift
  const [pinnedShifts, setPinnedShifts] = useState({}); // key -> shift code, a manager's hand-written exact-code commitment
  const [pinPickerCell, setPinPickerCell] = useState(null); // key of the PTO-grid cell currently showing its code picker, or null
  const [extraAvailable, setExtraAvailable] = useState({});
  const [holidays, setHolidays] = useState(new Set());
  const [holidayInput, setHolidayInput] = useState("");
  const [shiftDefinitions, setShiftDefinitions] = useState([]); // this manager's own shift roster
  const [newExtraName, setNewExtraName] = useState("");
  const [newExtraShifts, setNewExtraShifts] = useState([]);
  const [newPermanentName, setNewPermanentName] = useState("");
  const [schedule, setSchedule] = useState(null);
  // Two named save slots (1 and 2) — snapshots the manager explicitly
  // saved to keep around, as opposed to `schedule` above which silently
  // tracks whatever's currently on screen. { 1: { snapshot, saved_at } | null, 2: ... }
  const [scheduleSlots, setScheduleSlots] = useState({ 1: null, 2: null });
  const [tab, setTab] = useState("instructions");
  const [generating, setGenerating] = useState(false);
  const [generatingRotation, setGeneratingRotation] = useState(false);
  // N for Regenerate-N's code-repeat cooldown: how many of an
  // employee's OWN other worked turns must pass before the same shift
  // code can land on them again. null means "track the current shift
  // roster automatically" (see rotationCodes.length below) rather than
  // a number the manager explicitly chose — once they pick one from the
  // dropdown, it stays pinned to that exact number even if the shift
  // list changes later.
  const [codeRepeatCooldown, setCodeRepeatCooldown] = useState(null);
  // Session-only undo history — a schedule snapshot pushed right before
  // ANY action that replaces or edits it (both Regenerate buttons, every
  // manual drag/fill, loading a save slot), capped at the last 10 so it
  // never grows unbounded over a long session. Not persisted to the
  // database — same as kickedOutCells/missingShiftCells/dismissedAlerts,
  // it's a this-session safety net, not a permanent audit trail, and it
  // resets whenever a schedule is freshly loaded (see the initial-load
  // effect) since a different load means a different history entirely.
  const [undoStack, setUndoStack] = useState([]);
  const UNDO_LIMIT = 10;
  const [loaded, setLoaded] = useState(false);
  const [syncError, setSyncError] = useState(null);
  const [leaveStart, setLeaveStart] = useState("");
  const [leaveEnd, setLeaveEnd] = useState("");
  const [leaveType, setLeaveType] = useState("PTO1");
  const [leaveWarning, setLeaveWarning] = useState(null);
  // Whose data is currently loaded/edited. Defaults to (and, for a
  // regular manager, always stays) your own account. An admin can
  // switch this to a specific manager's ID to view and edit their
  // roster instead — everything reads/writes through this one value
  // so that switch only has to happen in one place.
  const [viewingOwnerId, setViewingOwnerId] = useState(session.user.id);
  const [allProfiles, setAllProfiles] = useState([]);
  const reportSyncError = (err) => { console.error(err); setSyncError(err.message || String(err)); };

  // Admin-only "Import" tab: copies another account's data into whichever
  // account is currently being viewed/edited (viewingOwnerId), overwriting
  // just the sections checked. Schedule only makes sense together with a
  // matching Permanent+PRN roster (the grid is full of bare employee IDs
  // with no meaning on their own), so picking it forces both on.
  const [importSourceId, setImportSourceId] = useState("");
  const [importSections, setImportSections] = useState({ setup: false, permanent: false, prn: false, schedule: false });
  const [importRunning, setImportRunning] = useState(false);
  const [importResult, setImportResult] = useState(null); // { summary: string[], error: string|null } | null
  const toggleImportSection = (section) => {
    setImportSections((prev) => {
      const next = { ...prev, [section]: !prev[section] };
      if (section === "schedule" && next.schedule) { next.permanent = true; next.prn = true; }
      if ((section === "permanent" || section === "prn") && !next[section] && prev.schedule) { next.schedule = false; }
      return next;
    });
  };

  // Per-cell write queue for the PTO grid's click-to-cycle — a cell's
  // status now spans TWO tables (pto_status, forced_holiday_work), so a
  // transition's writes have to land in the same order the clicks
  // happened in, or a fast double-click could have a stale write from
  // an earlier state complete after a later one and leave the two
  // tables disagreeing (e.g. a cell showing both PTO-1 and forced).
  // Chaining each cell's writes onto its own promise guarantees that
  // ordering regardless of network timing, without blocking the UI —
  // local state still updates instantly on every click.
  const ptoWriteQueue = useRef({});
  const queueCellWrite = (k, fn) => {
    const prev = ptoWriteQueue.current[k] || Promise.resolve();
    const next = prev.then(fn).catch(reportSyncError);
    ptoWriteQueue.current[k] = next;
    return next;
  };

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
    setScheduleSlots({ 1: null, 2: null });
    setTab("setup");
  };

  // Restores a saved schedule snapshot (from saved_schedules on login, or
  // from a save slot on demand) as the active schedule — not just the
  // `days`/fairness data, but the numWeeks/startDate/settings that
  // generated it too, since `days` itself is derived from those. One
  // place so a slot load does exactly what the login restore already does.
  const applyScheduleSnapshot = (snap) => {
    setSchedule(snap);
    setNumWeeks(snap.numWeeks);
    setStartDate(snap.startDate);
    const s = snap.settingsUsed;
    setMaxConsecutiveDays(s.maxConsecutiveDays);
    setConsecutiveHardLimit(s.consecutiveHardLimit);
    setGroupDaysOff(s.groupDaysOff);
    setAvoidLonelyShifts(s.avoidLonelyShifts);
    setWeekendPairingEnabled(s.weekendPairingEnabled);
    setExtendOffWeekends(!!s.extendOffWeekends);
    setCushionShiftCodes(s.cushionShiftCodes || []);
    setManualEditWarnings([]);
    setKickedOutCells(new Set());
    setMissingShiftCells(new Set());
    setMissingShiftReport(null);
    setDismissedAlerts(new Set());
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
        // Every manager gets exactly one reserved overflow shift (E0),
        // self-healing here if it's somehow missing — new account,
        // account from before this feature existed, or just never got
        // created. Renaming it is fine (like any shift); only the
        // reserved code and the "overflow" flag matter to the scheduler.
        // upsert (not insert) on purpose — React can run this effect
        // twice in a row in dev, and an upsert just writes the same row
        // twice harmlessly where a plain insert would hit a duplicate-key
        // error the second time. Best-effort, same as the schedule
        // restore below — this must never be able to block employees/
        // shifts from loading.
        if (!finalDefs.some((d) => d.overflow)) {
          const e0Def = { code: OVERFLOW_CODE, label: null, sortOrder: finalDefs.length, activeWeekend: true, weekendOnly: false, collapsed: false, continuityMin: null, continuityMax: null, overflow: true };
          await upsertShiftDefinition(e0Def, viewingOwnerId).catch(reportSyncError);
          finalDefs = [...finalDefs, e0Def];
        }
        if (cancelled) return;
        setEmployees(emp);
        setHolidays(new Set(hol));
        setShiftDefinitions(finalDefs);
        // Best-effort: restoring the last schedule is a nice-to-have, not
        // core data, so a failure here (or an account with no saved
        // schedule yet) must never block the rest of the app from loading.
        const savedSchedule = await fetchScheduleSnapshot(viewingOwnerId).catch((err) => { reportSyncError(err); return null; });
        if (cancelled) return;
        setUndoStack([]);
        if (savedSchedule) applyScheduleSnapshot(savedSchedule);
        // Save slots are their own best-effort fetch, same reasoning as
        // the rest of this block — a missing table (migration not yet
        // run) or a fetch error must never block the rest of the app.
        const slotRows = await fetchScheduleSlots(viewingOwnerId).catch((err) => { reportSyncError(err); return []; });
        if (cancelled) return;
        const nextSlots = { 1: null, 2: null };
        slotRows.forEach((row) => { nextSlots[row.slot] = { snapshot: row.snapshot, savedAt: row.saved_at, name: row.name || null }; });
        setScheduleSlots(nextSlots);
      } catch (err) {
        if (!cancelled) reportSyncError(err);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [viewingOwnerId]);

  // Admin import: copies one or more sections of importSourceId's account
  // into whatever account is currently being viewed (viewingOwnerId),
  // overwriting that destination's data for every section checked. Employee
  // IDs are a single sequence shared by every account, not owner-scoped, so
  // copying an employee means inserting a fresh row (new ID) and remapping
  // every place the OLD id was referenced — the PTO/pin/forced-work/
  // availability tables, and the bare empId numbers buried inside a
  // schedule snapshot's JSON, which Postgres has no idea refer to employees
  // at all. idMap carries that old-id -> new-id translation through the
  // whole run.
  const runImport = async () => {
    if (!importSourceId || importSourceId === viewingOwnerId || importRunning) return;
    const sections = importSections;
    if (!sections.setup && !sections.permanent && !sections.prn && !sections.schedule) return;
    const sourceName = allProfiles.find((p) => p.id === importSourceId)?.name || "that account";
    const destName = viewingOwnerId === session.user.id ? "your own account" : (allProfiles.find((p) => p.id === viewingOwnerId)?.name || "this account");
    const pieces = [
      sections.setup && "Setup (shift list, holidays, rotation settings)",
      sections.permanent && "Permanent staff",
      sections.prn && "PRN staff",
      sections.schedule && "Schedule",
    ].filter(Boolean);
    if (!window.confirm(`Import ${pieces.join(", ")} from ${sourceName} into ${destName}?\n\nThis OVERWRITES the current data in ${destName} for everything checked, and cannot be undone.`)) return;

    setImportRunning(true);
    setImportResult(null);
    const importSummary = [];
    // Old employee id (in importSourceId's account) -> new id (freshly
    // inserted under viewingOwnerId) — only populated for employees this
    // run actually imported.
    const idMap = {};
    try {
      if (sections.setup) {
        const [srcDefs, srcHolidays] = await Promise.all([fetchShiftDefinitions(importSourceId), fetchHolidays(importSourceId)]);
        await deleteAllShiftDefinitions(viewingOwnerId);
        if (srcDefs.length > 0) await insertShiftDefinitions(srcDefs, viewingOwnerId);
        await deleteAllHolidays(viewingOwnerId);
        await Promise.all(srcHolidays.map((iso) => addHolidayRow(iso, viewingOwnerId)));
        importSummary.push(`Setup: ${srcDefs.length} shift code(s), ${srcHolidays.length} holiday(s)`);
      }

      const importRoster = async (type, label) => {
        const [srcEmployees, srcPto, srcForced, srcPins, srcAvail] = await Promise.all([
          fetchEmployees(importSourceId),
          fetchAllPtoStatus(importSourceId),
          fetchAllForcedHolidayWork(importSourceId),
          fetchAllPinnedShifts(importSourceId),
          fetchAllExtraAvailability(importSourceId),
        ]);
        const srcOfType = srcEmployees.filter((e) => e.type === type);
        await deleteAllEmployeesOfType(type, viewingOwnerId);
        for (const emp of srcOfType) {
          const inserted = await insertEmployee(emp, viewingOwnerId);
          idMap[emp.id] = inserted.id;
        }
        const remapRows = (rows, extra = {}) => rows.filter((r) => idMap[r.employee_id] != null).map((r) => ({ ...r, employee_id: idMap[r.employee_id], owner_id: viewingOwnerId, ...extra }));
        await bulkUpsertPtoStatus(remapRows(srcPto));
        await bulkUpsertForcedHolidayWork(remapRows(srcForced));
        await bulkUpsertPinnedShifts(remapRows(srcPins));
        await bulkUpsertExtraAvailability(remapRows(srcAvail));
        importSummary.push(`${label}: ${srcOfType.length} employee(s)`);
      };
      if (sections.permanent) await importRoster("permanent", "Permanent staff");
      if (sections.prn) await importRoster("extra", "PRN staff");

      if (sections.schedule) {
        const srcSnapshot = await fetchScheduleSnapshot(importSourceId);
        if (srcSnapshot) {
          let droppedAssignments = 0;
          const remapDays = srcSnapshot.days.map((day) => {
            const assignment = {};
            Object.entries(day.assignment).forEach(([code, info]) => {
              if (info.empId == null) { assignment[code] = info; return; }
              const newId = idMap[info.empId];
              if (newId == null) { droppedAssignments++; return; }
              assignment[code] = { ...info, empId: newId };
            });
            return { ...day, assignment };
          });
          const remapFairness = (list) => (list || []).filter((f) => idMap[f.id] != null).map((f) => ({ ...f, id: idMap[f.id] }));
          const remappedSnapshot = { ...srcSnapshot, days: remapDays, fairness: remapFairness(srcSnapshot.fairness), extraFairness: remapFairness(srcSnapshot.extraFairness) };
          await saveScheduleSnapshot(remappedSnapshot, viewingOwnerId);
          applyScheduleSnapshot(remappedSnapshot);
          importSummary.push(`Schedule: ${remapDays.length} day(s)${droppedAssignments > 0 ? ` (dropped ${droppedAssignments} assignment(s) whose employee no longer exists in the source)` : ""}`);
        } else {
          importSummary.push("Schedule: source account has no saved schedule — nothing to copy");
        }
      } else if (sections.permanent || sections.prn) {
        // The roster just changed underneath whatever schedule is
        // currently active here — its empId values point at employees
        // that may no longer exist, so it can't be trusted. Clearing it
        // is safer than leaving a grid full of broken references.
        await deleteScheduleSnapshot(viewingOwnerId).catch(() => {});
        setSchedule(null);
        importSummary.push("Cleared the existing Schedule here — it referenced the roster that was just replaced");
      }

      if (sections.setup && !sections.schedule) {
        const srcSettingsSnapshot = await fetchScheduleSnapshot(importSourceId).catch(() => null);
        if (srcSettingsSnapshot) {
          setNumWeeks(srcSettingsSnapshot.numWeeks);
          setStartDate(srcSettingsSnapshot.startDate);
          const s = srcSettingsSnapshot.settingsUsed || {};
          setMaxConsecutiveDays(s.maxConsecutiveDays);
          setConsecutiveHardLimit(s.consecutiveHardLimit);
          setGroupDaysOff(s.groupDaysOff);
          setAvoidLonelyShifts(s.avoidLonelyShifts);
          setWeekendPairingEnabled(s.weekendPairingEnabled);
          setExtendOffWeekends(!!s.extendOffWeekends);
          setCushionShiftCodes(s.cushionShiftCodes || []);
          importSummary.push("Setup: also carried over the rotation/generator settings from the source's saved schedule");
        }
      }

      const [freshEmployees, freshHolidays, freshDefs] = await Promise.all([
        fetchEmployees(viewingOwnerId), fetchHolidays(viewingOwnerId), fetchShiftDefinitions(viewingOwnerId),
      ]);
      setEmployees(freshEmployees);
      setHolidays(new Set(freshHolidays));
      setShiftDefinitions(freshDefs);

      setImportResult({ summary: importSummary, error: null });
    } catch (err) {
      reportSyncError(err);
      setImportResult({ summary: importSummary, error: err.message || String(err) });
    } finally {
      setImportRunning(false);
    }
  };

  const days = useMemo(() => {
    const start = new Date(startDate + "T00:00:00");
    return Array.from({ length: numWeeks * 7 }, (_, idx) => {
      const date = new Date(start);
      date.setDate(start.getDate() + idx);
      const dow = date.getDay();
      return { idx, date, iso: toLocalISO(date), ...fmtLabel(date), isWeekend: dow === 0 || dow === 6, dow };
    });
  }, [numWeeks, startDate]);

  // Weekend index 0 for this schedule = its own first Saturday, so "group
  // 1 of N" always lands on the first weekend currently in view, no
  // matter what start date is picked.
  const weekendEpoch = useMemo(() => scheduleWeekendEpoch(days), [days]);

  // wouldExceedShiftCap's perBlockCap for a given capped employee —
  // their PTO-reduced guarantee target, used as the actual ceiling
  // during matching and local search, not just the floor the top-up
  // pass fills to. Without this, an employee with approved PTO-1 could
  // still get scheduled up to their full flat cap from the main
  // matching pass (which has no idea PTO should shrink anything), then
  // never get trimmed back down — the guarantee only ever adds shifts,
  // it was never meant to remove ones matching already gave out.
  // Always ≤ the flat cap, so this can only tighten things, never let
  // anyone past their real cap.
  const capForBlock = (emp) => {
    if (!emp.shiftCap) return undefined;
    const { windowDays, maxShifts } = emp.shiftCap;
    return (blockIndex) => guaranteeTargetForBlock(ptoStatus, ptoSource, emp.id, blockIndex * windowDays, blockIndex * windowDays + windowDays, maxShifts);
  };

  // Whether working this day would cut into an employee's off-weekend —
  // the "extend off-weekends into a long weekend" preference uses this to
  // softly discourage it. Only for someone on a weekend rotation, only
  // the Friday right before or the Monday right after their OFF weekend,
  // and never a day that's one of their fixed days — nothing to be done
  // about those regardless, so there's no point penalizing them.
  const breaksOffWeekend = (e, day) => {
    if (!extendOffWeekends || !e || !e.weekendRotation || e.fixedDays.includes(day.dow)) return false;
    return isAdjacentToOffWeekend(e.weekendRotation, day.date, day.dow, weekendEpoch);
  };

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
        // forced_holiday_work is a newer table that needs its own migration
        // run — fetched separately, defaulting to empty on failure (e.g.
        // the migration hasn't been run yet), so a missing table there
        // can never take down PTO/availability loading along with it.
        const [ptoRows, availRows] = await Promise.all([fetchPtoStatus(startIso, endIso, viewingOwnerId), fetchExtraAvailability(startIso, endIso, viewingOwnerId)]);
        const forcedRows = await fetchForcedHolidayWork(startIso, endIso, viewingOwnerId).catch((err) => { reportSyncError(err); return []; });
        const pinnedRows = await fetchPinnedShifts(startIso, endIso, viewingOwnerId).catch((err) => { reportSyncError(err); return []; });
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
        const nextForced = {};
        forcedRows.forEach((r) => { const idx = isoToIdx.get(r.day_iso); if (idx !== undefined) nextForced[key(r.employee_id, idx)] = true; });
        const nextPinned = {};
        pinnedRows.forEach((r) => { const idx = isoToIdx.get(r.day_iso); if (idx !== undefined) nextPinned[key(r.employee_id, idx)] = r.code; });
        setPtoStatus(nextPto);
        setPtoSource(nextPtoSource);
        setExtraAvailable(nextAvail);
        setForcedHolidayWork(nextForced);
        setPinnedShifts(nextPinned);
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
  // The overflow shift (E0) is never a required daily slot — it only
  // ever exists to top someone up to their guaranteed count — so it's
  // deliberately left out of both of these; nothing that fills/checks a
  // day's required coverage should ever see it.
  const weekdayShifts = ALL_SHIFT_CODES.filter((s) => !shiftDefByCode[s].collapsed && !shiftDefByCode[s].weekendOnly && !shiftDefByCode[s].overflow);
  const weekendShifts = ALL_SHIFT_CODES.filter((s) => (shiftDefByCode[s].activeWeekend || shiftDefByCode[s].weekendOnly) && !shiftDefByCode[s].collapsed && !shiftDefByCode[s].overflow);
  // The weekday codes Regenerate-N actually rotates through — real
  // shifts only, continuity blocks excluded (those are a locked
  // non-negotiable, never something the rotation assigns itself).
  // Shared with the "Early repeats" fairness metric below, and with the
  // N-cooldown dropdown's own default and option list, so all three
  // always agree on what "a full cycle" means for this account's roster.
  const rotationCodes = weekdayShifts.filter((s) => !isContinuityCode(s));
  // Training doesn't apply to the overflow shift — anyone with an
  // extended-hour schedule is automatically eligible for it — so it's
  // left out of every "Trained on" picker to avoid a toggle that does
  // nothing.
  const trainableShiftCodes = ALL_SHIFT_CODES.filter((s) => !shiftDefByCode[s].overflow);
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
  // Weekend-only implies weekend-active (see weekendShifts above) — no
  // need to also tick "Weekend/holiday?" separately.
  const toggleShiftWeekendOnly = (code) => updateShiftDefinition(code, { weekendOnly: !shiftDefByCode[code].weekendOnly });
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
    const code = `E${nextNum}`;
    const newDef = { code, label: null, sortOrder: shiftDefinitions.length, activeWeekend: false, weekendOnly: false, collapsed: false, continuityMin: null, continuityMax: null };
    setShiftDefinitions((prev) => [...prev, newDef]);
    upsertShiftDefinition(newDef, viewingOwnerId).catch(reportSyncError);
    // Permanent staff default to "trained on everything" (see addPermanent)
    // — a newly added shift should keep that default true for them, same
    // as it implicitly always was before per-shift training existed. PRN
    // staff are deliberately left out here: their training has always been
    // a curated whitelist the manager sets by hand, never "everything".
    setEmployees((prev) => prev.map((e) => {
      if (e.type !== "permanent") return e;
      const updated = { ...e, allowedShifts: [...e.allowedShifts, code] };
      upsertEmployee(updated, viewingOwnerId).catch(reportSyncError);
      return updated;
    }));
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
  // Which shifts a permanent employee is trained/qualified for — same
  // field PRN staff already use (allowedShifts), just editable after the
  // fact instead of only set at creation. New employees default to every
  // shift checked (see addPermanent), so turning this on never silently
  // excludes anyone until a manager actively unchecks something.
  const toggleEmployeeAllowedShift = (empId, code) =>
    setEmployees((prev) => prev.map((e) => {
      if (e.id !== empId) return e;
      const updated = { ...e, allowedShifts: e.allowedShifts.includes(code) ? e.allowedShifts.filter((c) => c !== code) : [...e.allowedShifts, code] };
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
        const wIdx = weekendIndexFor(d.date, weekendEpoch);
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
  // Bulk block/clear a date range as PTO-1 (hard), PTO-2 (soft/DNS), or a
  // FORCED holiday-work tag, per the leaveType toggle — for extended
  // absences, DNS stretches, or a run of mandatory holidays, instead of
  // clicking each day.
  const blockLeave = (empId) => {
    if (!leaveStart || !leaveEnd || leaveStart > leaveEnd) return;
    const affected = days.filter((d) => d.iso >= leaveStart && d.iso <= leaveEnd);
    if (affected.length === 0) return;
    const emp = permanent.find((p) => p.id === empId);
    if (leaveType === "FORCED") {
      // A forced-work tag only ever makes sense where approved PTO-1
      // doesn't already block the day — the generator skips a forced day
      // that collides with PTO-1 rather than silently overriding
      // approved leave, so flag it here too instead of leaving the
      // manager to discover it only once a schedule comes back short.
      const blocked = affected.filter((d) => ptoStatus[key(empId, d.idx)] === "PTO1");
      setLeaveWarning(blocked.length > 0
        ? `${emp?.name || "This employee"}'s forced-work tag (${leaveStart} to ${leaveEnd}) includes ${blocked.length} day(s) already approved as PTO-1: ${blocked.map((d) => `${d.wd} ${d.md}`).join(", ")}. The generator won't override approved leave — clear their PTO-1 first if they still need to work those days.`
        : null);
      setForcedHolidayWork((prev) => {
        const next = { ...prev };
        affected.forEach((d) => { next[key(empId, d.idx)] = true; });
        return next;
      });
      bulkUpsertForcedHolidayWork(affected.map((d) => ({ employee_id: empId, day_iso: d.iso, owner_id: viewingOwnerId }))).catch(reportSyncError);
      return;
    }
    // A PTO-1 request that overlaps a day already off per weekend
    // rotation isn't using any extra leave — they weren't scheduled to
    // work it either way — so flag it rather than silently stamping
    // "manual" over the rotation day and (per guaranteeTargetForBlock)
    // shrinking their real-shift guarantee for a day they were never
    // going to work in the first place.
    if (leaveType === "PTO1") {
      const alreadyOff = affected.filter((d) => ptoStatus[key(empId, d.idx)] === "PTO1" && ptoSource[key(empId, d.idx)] === "weekend_rotation");
      setLeaveWarning(alreadyOff.length > 0
        ? `${emp?.name || "This employee"}'s PTO-1 request (${leaveStart} to ${leaveEnd}) includes ${alreadyOff.length} day(s) already off per weekend rotation: ${alreadyOff.map((d) => `${d.wd} ${d.md}`).join(", ")}. They weren't scheduled to work those days anyway, so this won't use any extra leave — just flagging in case that wasn't intended.`
        : null);
    } else {
      setLeaveWarning(null);
    }
    setPtoStatus((prev) => {
      const next = { ...prev };
      affected.forEach((d) => { next[key(empId, d.idx)] = leaveType; });
      return next;
    });
    setPtoSource((prev) => {
      const next = { ...prev };
      affected.forEach((d) => { next[key(empId, d.idx)] = "manual"; });
      return next;
    });
    bulkUpsertPtoStatus(affected.map((d) => ({ employee_id: empId, day_iso: d.iso, status: leaveType, source: "manual", owner_id: viewingOwnerId }))).catch(reportSyncError);
  };
  const clearLeave = (empId) => {
    if (!leaveStart || !leaveEnd || leaveStart > leaveEnd) return;
    const affected = days.filter((d) => d.iso >= leaveStart && d.iso <= leaveEnd);
    if (affected.length === 0) return;
    if (leaveType === "FORCED") {
      setForcedHolidayWork((prev) => {
        const next = { ...prev };
        affected.forEach((d) => { delete next[key(empId, d.idx)]; });
        return next;
      });
      bulkDeleteForcedHolidayWork(empId, leaveStart, leaveEnd, viewingOwnerId).catch(reportSyncError);
      return;
    }
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
  // Five-state cycle: available → PTO-1 (hard) → PTO-2 (soft) → forced
  // holiday work → a manually pinned shift code → available. Each state
  // is exclusive of the others — moving into one always clears whichever
  // of PTO/DNS, the forced tag, or a pin might still be set on this
  // cell, so a click cycle never leaves two contradictory flags on the
  // same day. Any manual click also claims the cell away from auto-set
  // weekend rotation, same as before — future "Apply weekend rotation"
  // runs will never touch it again.
  //
  // Entering the pin state doesn't commit anything by itself — there's
  // no single "the" pinned code, so this just opens an inline code
  // picker for the cell (see commitPin) and leaves everything else
  // alone until the manager actually chooses one.
  const cyclePto = (empId, dayIdx) => {
    const k = key(empId, dayIdx);
    const iso = days[dayIdx]?.iso;
    const currentState = pinnedShifts[k] ? 4 : forcedHolidayWork[k] ? 3 : ptoStatus[k] === "PTO1" ? 1 : ptoStatus[k] === "PTO2" ? 2 : 0;
    const nextState = (currentState + 1) % 5;

    if (nextState === 4) {
      setPinPickerCell(k);
      return;
    }

    setPtoStatus((prev) => {
      const next = { ...prev };
      if (nextState === 1) next[k] = "PTO1";
      else if (nextState === 2) next[k] = "PTO2";
      else delete next[k];
      return next;
    });
    setPtoSource((prev) => {
      const next = { ...prev };
      if (nextState === 1 || nextState === 2) next[k] = "manual"; else delete next[k];
      return next;
    });
    setForcedHolidayWork((prev) => {
      const next = { ...prev };
      if (nextState === 3) next[k] = true; else delete next[k];
      return next;
    });
    if (currentState === 4) {
      setPinnedShifts((prev) => { const next = { ...prev }; delete next[k]; return next; });
    }

    if (!iso) return;
    queueCellWrite(k, async () => {
      if (nextState === 1 || nextState === 2) await upsertPtoStatus(empId, iso, nextState === 1 ? "PTO1" : "PTO2", "manual", viewingOwnerId);
      else await deletePtoStatus(empId, iso, viewingOwnerId);
      if (nextState === 3) await bulkUpsertForcedHolidayWork([{ employee_id: empId, day_iso: iso, owner_id: viewingOwnerId }]);
      else if (currentState === 3) await bulkDeleteForcedHolidayWork(empId, iso, iso, viewingOwnerId);
      if (currentState === 4) await deletePinnedShift(empId, iso, viewingOwnerId);
    });
  };

  // Commits (or, with an empty code, cancels) the inline code picker a
  // click into the "pin" cycle state opened. Picking a code is exclusive
  // of PTO/DNS/forced the same way every other state transition is.
  const commitPin = (empId, dayIdx, code) => {
    const k = key(empId, dayIdx);
    const iso = days[dayIdx]?.iso;
    setPinPickerCell(null);
    if (!code) return;
    setPtoStatus((prev) => { const next = { ...prev }; delete next[k]; return next; });
    setPtoSource((prev) => { const next = { ...prev }; delete next[k]; return next; });
    setForcedHolidayWork((prev) => { const next = { ...prev }; delete next[k]; return next; });
    setPinnedShifts((prev) => ({ ...prev, [k]: code }));
    if (!iso) return;
    queueCellWrite(k, async () => {
      await deletePtoStatus(empId, iso, viewingOwnerId);
      await bulkDeleteForcedHolidayWork(empId, iso, iso, viewingOwnerId);
      await upsertPinnedShift(empId, iso, code, viewingOwnerId);
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
  // Which days of the week a PRN person is generally available — only
  // used to bulk-fill the grid below (see applyAvailabilityPattern);
  // doesn't affect the scheduler directly.
  const toggleExtraAvailableDow = (empId, dow) =>
    setEmployees((prev) => prev.map((e) => {
      if (e.id !== empId) return e;
      const updated = { ...e, availableDaysOfWeek: e.availableDaysOfWeek.includes(dow) ? e.availableDaysOfWeek.filter((d) => d !== dow) : [...e.availableDaysOfWeek, dow] };
      upsertEmployee(updated, viewingOwnerId).catch(reportSyncError);
      return updated;
    }));
  // Marks this PRN person available on every given day and saves it — the
  // one bulk-fill routine shared by "Apply availability pattern" (the
  // whole visible range) and the leave range's "Clear" button, so there's
  // one place that does this instead of two near-duplicates.
  const fillExtraAvailability = (empId, daysToFill) => {
    if (daysToFill.length === 0) return;
    setExtraAvailable((prev) => {
      const next = { ...prev };
      daysToFill.forEach((d) => { next[key(empId, d.idx)] = true; });
      return next;
    });
    bulkUpsertExtraAvailability(daysToFill.map((d) => ({ employee_id: empId, day_iso: d.iso, owner_id: viewingOwnerId }))).catch(reportSyncError);
  };
  // Click once to mark every day matching their weekly pattern available
  // across the whole visible schedule — instead of clicking each day by
  // hand. Safe to re-run any time (after extending the date range, say):
  // it only ever ADDS availability, so a day you removed by hand stays
  // removed unless it's re-added here another explicit click away.
  const applyAvailabilityPattern = (empId) => {
    const emp = employees.find((e) => e.id === empId);
    if (!emp) return;
    fillExtraAvailability(empId, days.filter((d) => emp.availableDaysOfWeek.includes(d.dow)));
  };
  // Bulk block/clear a date range on the availability grid — same idea as
  // permanent staff's "Block leave"/"Clear", but for PRN: "Block" marks
  // the whole range unavailable (vacation etc.); "Clear" undoes that by
  // restoring their normal weekly pattern over that same range.
  const blockExtraLeave = (empId) => {
    if (!leaveStart || !leaveEnd || leaveStart > leaveEnd) return;
    const affected = days.filter((d) => d.iso >= leaveStart && d.iso <= leaveEnd);
    if (affected.length === 0) return;
    setExtraAvailable((prev) => {
      const next = { ...prev };
      affected.forEach((d) => { delete next[key(empId, d.idx)]; });
      return next;
    });
    bulkDeleteExtraAvailability(empId, leaveStart, leaveEnd, viewingOwnerId).catch(reportSyncError);
  };
  const clearExtraLeave = (empId) => {
    if (!leaveStart || !leaveEnd || leaveStart > leaveEnd) return;
    const emp = employees.find((e) => e.id === empId);
    if (!emp) return;
    fillExtraAvailability(empId, days.filter((d) => d.iso >= leaveStart && d.iso <= leaveEnd && emp.availableDaysOfWeek.includes(d.dow)));
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
    const draft = { name: newExtraName.trim(), type: "extra", fixedDays: [], allowedShifts: [...newExtraShifts], shiftCap: null, availableDaysOfWeek: [] };
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
      name: newPermanentName.trim(), type: "permanent", fixedDays: [], allowedShifts: [...trainableShiftCodes],
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
      const updated = { ...e, type: "permanent", allowedShifts: [...trainableShiftCodes] };
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
  const assignContinuityBlocks = (code, rule, committedDays, pinnedByDay, pinnedDaysByEmp) => {
    const dayAssignment = {};
    if (!weekdayShifts.includes(code)) return dayAssignment;

    // A day already pinned to THIS exact code (manual shift pin, decided
    // before continuity ever runs — see generate()) splits a run the same
    // way a weekend or holiday does: it's already spoken for, so no block
    // built here can cross it. The pin itself isn't re-recorded into
    // dayAssignment — it's merged into the day separately — this just
    // keeps continuity from fighting over or silently ignoring it. Blocks
    // on either side are free to land on whoever normally would, pinned
    // employee included.
    const runs = [];
    let current = [];
    days.forEach((d) => {
      const isOff = d.isWeekend || holidays.has(d.iso) || !!pinnedByDay?.[d.idx]?.[code];
      if (!isOff) current.push(d); else { if (current.length) runs.push(current); current = []; }
    });
    if (current.length) runs.push(current);

    const stat = {}; permanent.forEach((e) => { stat[e.id] = 0; });
    const extraStat = {}; extra.forEach((e) => { extraStat[e.id] = 0; });
    // Seeded with each employee's pinned days (any code) so a block built
    // here can't push someone already pinned elsewhere in this window past
    // their cap.
    const workedDaysByEmp = {}; permanent.forEach((e) => { workedDaysByEmp[e.id] = [...(pinnedDaysByEmp?.[e.id] || [])]; });
    const extraWorkedDaysByEmp = {}; extra.forEach((e) => { extraWorkedDaysByEmp[e.id] = []; });
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
        const underCap = (e) => !wouldExceedShiftCap(e, workedDaysByEmp[e.id], blockDayIndices, capForBlock(e));
        const blockDows = blockDays.map((d) => d.dow);
        const fitsFixedDays = (e) => respectsFixedDayRestriction(e, blockDows);
        const tier1 = permanent.filter((e) => e.allowedShifts.includes(code) && blockDays.every((d) => !ptoStatus[key(e.id, d.idx)]) && underCap(e) && fitsFixedDays(e) && !isCommitted(`p:${e.id}`, blockDays));
        const tier2 = permanent.filter((e) => e.allowedShifts.includes(code) && !anyPto1(e) && blockDays.some((d) => ptoStatus[key(e.id, d.idx)] === "PTO2") && underCap(e) && fitsFixedDays(e) && !isCommitted(`p:${e.id}`, blockDays));
        const sortFn = (a, b) => stat[a.id] - stat[b.id] || Math.random() - 0.5;
        let chosen = null, type = "permanent", override = false;
        if (tier1.length) { tier1.sort(sortFn); chosen = tier1[0]; }
        else if (tier2.length) { tier2.sort(sortFn); chosen = tier2[0]; override = true; }
        else {
          const poolE = extra.filter((e) => e.allowedShifts.includes(code) && blockDays.every((d) => extraAvailable[key(e.id, d.idx)])
            && !wouldExceedShiftCap(e, extraWorkedDaysByEmp[e.id], blockDayIndices) && !isCommitted(`x:${e.id}`, blockDays));
          if (poolE.length) { poolE.sort((a, b) => extraStat[a.id] - extraStat[b.id]); chosen = poolE[0]; type = "extra"; }
        }
        if (chosen) {
          blockDays.forEach((d) => { dayAssignment[d.idx] = { empId: chosen.id, type, override }; });
          if (type === "permanent") { stat[chosen.id] += blockLen; workedDaysByEmp[chosen.id].push(...blockDayIndices); claim(`p:${chosen.id}`, blockDayIndices); }
          else { extraStat[chosen.id] += blockLen; extraWorkedDaysByEmp[chosen.id].push(...blockDayIndices); claim(`x:${chosen.id}`, blockDayIndices); }
        }
      });
    });
    return dayAssignment;
  };

  // ---- Weekend pairing pre-pass (permanent staff only) ----
  // If it's someone's weekend to work, they should work the SAME shift
  // both Saturday and Sunday — not shift A on Saturday and shift B on
  // Sunday, and not two different people covering the two days. Decide
  // both days of each weekend TOGETHER, before the regular day-by-day
  // walk gets a chance to match them independently. This also absorbs
  // the old "guarantee a capped employee their open weekend" behavior —
  // that's now just the first-tried tier per shift, below the general
  // pairing tier that covers anyone's ordinary weekend turn.
  // PRN is exempt by design, as asked: when nobody permanent can cover
  // both days, this pre-pass leaves that shift alone and the normal
  // per-day walk (PRN included) fills it in as it always has — so
  // pairing is best-effort, not an absolute guarantee. verifyWeekendPairing
  // (further down) flags the cases where that fallback actually happened.
  const assignWeekendPairs = (continuityDaysByEmp, pinnedByDay, pinnedDaysByEmp) => {
    const dayAssignment = {}; // dayIdx -> { [shift]: { empId, type, override, fixed } }
    // Continuity blocks are decided first (weekdays only) but this pre-pass
    // wouldn't otherwise know about them — seed those days in up front so
    // a weekend pairing can't combine with an already-locked continuity
    // block to quietly blow a cap window that spans both. This seeded
    // tracker is for THIS FUNCTION'S OWN eligibility checks only — it
    // must never be what gets returned, or the caller ends up counting
    // every continuity day twice (once directly, once via this) when it
    // combines continuity + weekend-pair days into capWorkedDays. Only
    // newWeekendDaysByEmp — the days THIS pass actually assigns — is
    // returned.
    const workedDaysByEmp = {}; permanent.forEach((e) => { workedDaysByEmp[e.id] = [...(continuityDaysByEmp?.[e.id] || []), ...(pinnedDaysByEmp?.[e.id] || [])]; });
    const newWeekendDaysByEmp = {}; permanent.forEach((e) => { newWeekendDaysByEmp[e.id] = []; });
    const stat = {}; permanent.forEach((e) => { stat[e.id] = 0; });
    // Same reasoning as the old guarantee pre-pass: weekday assignments
    // haven't been decided yet, so fixed days are projected as "worked"
    // for a realistic (if conservative) streak estimate.
    const projectedFixedDayIndices = {};
    permanent.forEach((e) => { projectedFixedDayIndices[e.id] = days.filter((d) => e.fixedDays.includes(d.dow)).map((d) => d.idx); });
    const hardStreak = consecutiveHardLimit ? maxConsecutiveDays : 0;

    const pairs = [];
    for (let i = 0; i < days.length; i++) {
      const sat = days[i];
      if (sat.dow !== 6) continue;
      const sun = days[i + 1];
      if (sun && sun.dow === 0) pairs.push([sat, sun]);
    }

    pairs.forEach(([sat, sun]) => {
      // A code already pinned on either day of this weekend is spoken
      // for — don't try to auto-pair it. The pinned day keeps its pin;
      // the other day falls through to the normal per-day walk, same as
      // any other weekend this pre-pass can't find a pairing for.
      const codes = weekendShifts.filter((s) => !isContinuityCode(s) && !pinnedByDay?.[sat.idx]?.[s] && !pinnedByDay?.[sun.idx]?.[s]);
      // Shuffle so the same shift code doesn't always win ties for the
      // lowest-stat candidate — same reasoning as shuffling `remaining`
      // in assignDay.
      for (let i = codes.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [codes[i], codes[j]] = [codes[j], codes[i]]; }
      const usedThisWeekend = new Set();
      const pinnedThisWeekend = (e) => Object.values(pinnedByDay?.[sat.idx] || {}).some((info) => info.empId === e.id)
        || Object.values(pinnedByDay?.[sun.idx] || {}).some((info) => info.empId === e.id);

      const eligibleBoth = (e) => !usedThisWeekend.has(e.id)
        && !pinnedThisWeekend(e) // already committed to a different code this weekend via a pin
        && !e.fixedDays.includes(sat.dow) && !e.fixedDays.includes(sun.dow) // fixed days already get priority elsewhere
        && ptoStatus[key(e.id, sat.idx)] !== "PTO1" && ptoStatus[key(e.id, sun.idx)] !== "PTO1"
        && respectsFixedDayRestriction(e, [sat.dow, sun.dow])
        && !wouldExceedShiftCap(e, workedDaysByEmp[e.id], [sat.idx, sun.idx], capForBlock(e))
        && !wouldExceedConsecutiveDays([...projectedFixedDayIndices[e.id], ...workedDaysByEmp[e.id]], [sat.idx, sun.idx], hardStreak);

      codes.forEach((shift) => {
        const trained = permanent.filter((e) => e.allowedShifts.includes(shift) && eligibleBoth(e));
        // Tier 1: a capped employee whose rotation says this is their open
        // weekend. Tier 2: anyone else — an ordinary permanent employee
        // who simply wins this weekend still gets the SAME shift both days.
        const rotationCandidates = trained.filter((e) => e.shiftCap && isOpenWeekend(e.weekendRotation, weekendIndexFor(sat.date, weekendEpoch)));
        const pool = rotationCandidates.length ? rotationCandidates : trained;
        if (!pool.length) return;
        pool.sort((a, b) => stat[a.id] - stat[b.id] || Math.random() - 0.5);
        const chosen = pool[0];
        usedThisWeekend.add(chosen.id);
        if (!dayAssignment[sat.idx]) dayAssignment[sat.idx] = {};
        if (!dayAssignment[sun.idx]) dayAssignment[sun.idx] = {};
        dayAssignment[sat.idx][shift] = { empId: chosen.id, type: "permanent", override: false, fixed: true };
        dayAssignment[sun.idx][shift] = { empId: chosen.id, type: "permanent", override: false, fixed: true };
        stat[chosen.id] += 2;
        workedDaysByEmp[chosen.id].push(sat.idx, sun.idx);
        newWeekendDaysByEmp[chosen.id].push(sat.idx, sun.idx);
      });
    });
    return { dayAssignment, workedDaysByEmp: newWeekendDaysByEmp };
  };

  const assignDay = (day, stats, extraStats, preAssigned = {}, capWorkedDays, extraCapWorkedDays, prevShiftByEmp = {}) => {
    const isWknd = day.isWeekend || holidays.has(day.iso);
    const activeShifts = isWknd ? weekendShifts : weekdayShifts;
    const statusOf = (id) => ptoStatus[key(id, day.idx)];
    // Strongly discourage (but don't forbid — the pool's eligibility isn't
    // touched) handing someone the identical shift they worked yesterday.
    // Same two exceptions as everywhere else this rule applies: a
    // Saturday->Sunday pair, and a continuity-tagged shift.
    const repeatsPrevShift = (id, shift) => {
      const prev = prevShiftByEmp[id];
      if (!prev || prev.dayIdx !== day.idx - 1 || prev.shift !== shift) return false;
      if (isContinuityCode(shift)) return false;
      if (prev.dow === 6 && day.dow === 0) return false;
      return true;
    };
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
    const underCap = (e) => !wouldExceedShiftCap(e, capWorkedDays[e.id], [day.idx], capForBlock(e));
    // Only bites in hard mode (maxConsecutiveDays passed as 0 disables
    // the check entirely, same trick wouldExceedShiftCap uses for "no
    // cap set"). In soft mode this preference is handled purely through
    // the cost function in costOf, so it never blocks an assignment.
    const underStreak = (e) => !wouldExceedConsecutiveDays(capWorkedDays[e.id], [day.idx], consecutiveHardLimit ? maxConsecutiveDays : 0);
    const fixedToday = permanent.filter((e) => e.fixedDays.includes(day.dow) && statusOf(e.id) !== "PTO1" && underCap(e) && underStreak(e));
    if (fixedToday.length && remaining.length) {
      const fixedCostFn = (id, shift) => shiftPref(stats[id], shift) + (repeatsPrevShift(id, shift) ? 800 : 0);
      const match = kuhnMatch(remaining, (shift) =>
        fixedToday.filter((e) => !usedIds.has(e.id) && e.allowedShifts.includes(shift)).map((e) => e.id)
          .sort((a, b) => fixedCostFn(a, shift) - fixedCostFn(b, shift) || Math.random() - 0.5));
      Object.entries(match).forEach(([shift, empId]) => { assignment[shift] = { empId, type: "permanent", override: false, fixed: true }; usedIds.add(empId); });
      remaining = remaining.filter((s) => !(s in match));
    }
    if (remaining.length) {
      const pool = permanent.filter((e) => !usedIds.has(e.id) && !statusOf(e.id) && underCap(e) && underStreak(e) && respectsFixedDayRestriction(e, [day.dow]));
      const costFn = (id, shift) => shiftPref(stats[id], shift) + (isWknd ? stats[id].weekendCount * 1000 : 0) + stats[id].totalWorked * 10 + (repeatsPrevShift(id, shift) ? 800 : 0) + (breaksOffWeekend(pool.find((e) => e.id === id), day) ? 400 : 0);
      const match = kuhnMatch(remaining, (shift) => pool.filter((e) => !usedIds.has(e.id) && e.allowedShifts.includes(shift)).map((e) => e.id).sort((a, b) => costFn(a, shift) - costFn(b, shift) || Math.random() - 0.5));
      Object.entries(match).forEach(([shift, empId]) => { assignment[shift] = { empId, type: "permanent", override: false, fixed: false }; usedIds.add(empId); });
      remaining = remaining.filter((s) => !(s in match));
    }
    if (remaining.length) {
      const pool2 = permanent.filter((e) => !usedIds.has(e.id) && statusOf(e.id) === "PTO2" && underCap(e) && underStreak(e) && respectsFixedDayRestriction(e, [day.dow]));
      const match = kuhnMatch(remaining, (shift) => pool2.filter((e) => !usedIds.has(e.id) && e.allowedShifts.includes(shift)).map((e) => e.id).sort((a, b) => stats[a].totalWorked - stats[b].totalWorked || Math.random() - 0.5));
      Object.entries(match).forEach(([shift, empId]) => { assignment[shift] = { empId, type: "permanent", override: true, fixed: false }; usedIds.add(empId); });
      remaining = remaining.filter((s) => !(s in match));
    }
    if (remaining.length) {
      const poolE = extra.filter((e) => !usedIds.has(e.id) && extraAvailable[key(e.id, day.idx)] && !wouldExceedShiftCap(e, extraCapWorkedDays[e.id], [day.idx]));
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
        extraCapWorkedDays[info.empId].push(day.idx);
      }
    });

    const continuityHoles = activeShifts.filter((s) => isContinuityCode(s) && !(s in preAssigned));
    return { ...day, isWknd, activeShifts, assignment, holes: [...remaining, ...continuityHoles] };
  };

  const computeStats = (daysArr) => {
    const stats = {};
    permanent.forEach((e) => { stats[e.id] = { totalWorked: 0, shiftCount: Object.fromEntries(ALL_SHIFT_CODES.map((s) => [s, 0])), weekendCount: 0, weekendDaysWorked: [], workedDays: [], codeByDay: {} }; });
    daysArr.forEach((day) => {
      Object.entries(day.assignment).forEach(([rawShift, info]) => {
        if (info.type === "permanent") {
          const shift = overflowBaseCode(rawShift);
          const st = stats[info.empId];
          st.totalWorked++; st.shiftCount[shift]++; st.workedDays.push(day.idx);
          st.codeByDay[day.idx] = shift;
          if (day.isWknd) { st.weekendCount++; st.weekendDaysWorked.push(day.idx); }
        }
      });
    });
    return stats;
  };

  // Shifts with nobody on them on a given day. Read from the assignment,
  // so it's correct after the optimizer has moved people around.
  const holesOnDay = (day) => unfilledShifts(day, day.isWknd ? weekendShifts : weekdayShifts);

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
    // Every permanent employee should work each active shift they're
    // TRAINED ON at least once this rotation — but only if they had any
    // non-blocked day to work it on at all (skip anyone on leave for the
    // whole span). A shift they're not trained for isn't a gap, so it's
    // excluded before checking, same as it's simply never offered to
    // them during matching.
    let missingShiftPenalty = 0;
    permanent.forEach((e) => {
      const hasAvailability = daysArr.some((d) => ptoStatus[key(e.id, d.idx)] !== "PTO1");
      if (!hasAvailability) return;
      weekdayShifts.filter((s) => e.allowedShifts.includes(s)).forEach((s) => { if (stats[e.id].shiftCount[s] === 0) missingShiftPenalty++; });
    });
    // In hard mode this always evaluates to 0 — the hard checks in
    // assignDay/assignWeekendPairs never let a run form in
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
    // Scattered single days off (work, off, work) cost a bit each. Zero
    // when the grouping toggle is off, so the score is unchanged then.
    let lonelyOffPenalty = 0;
    if (groupDaysOff) {
      permanent.forEach((e) => {
        const worked = stats[e.id].workedDays;
        const workedSet = new Set(worked);
        const free = daysArr.filter((d) => !workedSet.has(d.idx) && !ptoStatus[key(e.id, d.idx)]).map((d) => d.idx);
        lonelyOffPenalty += countLonelyDaysOff(worked, free);
      });
    }
    // Same idea for a lone workday between two days off. Zero when its
    // toggle is off.
    let lonelyShiftPenalty = 0;
    if (avoidLonelyShifts) {
      permanent.forEach((e) => { lonelyShiftPenalty += countLonelyShifts(stats[e.id].workedDays, daysArr.length); });
    }
    // Working the Friday or Monday right next to a rotated employee's OFF
    // weekend eats into the long weekend they could otherwise have. Zero
    // when the toggle is off, same as the other grouping preferences.
    let extendOffWeekendPenalty = 0;
    if (extendOffWeekends) {
      permanent.forEach((e) => {
        stats[e.id].workedDays.forEach((idx) => { if (breaksOffWeekend(e, daysArr[idx])) extendOffWeekendPenalty++; });
      });
    }
    // The same shift code two days running reads as monotonous — always
    // checked (no settings toggle, unlike the grouping preferences above),
    // weighted well above plain shift-count balance so the optimizer only
    // trades it away to fill a gap or fix a harder violation.
    let backToBackPenalty = 0;
    permanent.forEach((e) => {
      const dayEntries = daysArr.map((d) => ({ dow: d.dow, code: stats[e.id].codeByDay[d.idx] }));
      backToBackPenalty += countBackToBackSameShift(dayEntries, isContinuityCode);
    });
    // Each empty shift weighs more than any balance or grouping gain, so
    // the optimizer only gives up shift balance when that fills a gap.
    const emptyShifts = daysArr.reduce((sum, d) => sum + holesOnDay(d).length, 0);
    return emptyShifts * 30 + totalSpread * 5 + shiftSpread * 1 + weekendViol * 50 + missingShiftPenalty * 40 + consecutiveRunPenalty * 35 + lonelyOffPenalty * 15 + lonelyShiftPenalty * 15 + backToBackPenalty * 25 + extendOffWeekendPenalty * 15;
  };

  // Trades one employee's shift with a colleague's shift on a nearby day
  // (same shift code, same kind of day). Each day keeps the same number of
  // people on each shift, so coverage can't drop — the only thing that
  // changes is which days each person works. This is the move that lets the
  // optimizer line up an employee's days off into one block.
  const proposeDayTrade = (current, dIdx, entries) => {
    const [shift, infoX] = entries[Math.floor(Math.random() * entries.length)];
    const X = current[dIdx];
    const eId = infoX.empId;
    const E = permanent.find((p) => p.id === eId);
    if (!E || !E.allowedShifts.includes(shift) || ptoStatus[key(eId, X.idx)]) return null;
    const usedOnX = new Set(Object.values(X.assignment).map((v) => v.empId));
    const candidates = [];
    for (let jIdx = Math.max(0, dIdx - 3); jIdx <= Math.min(current.length - 1, dIdx + 3); jIdx++) {
      if (jIdx === dIdx) continue;
      const Y = current[jIdx];
      if (Y.isWknd !== X.isWknd) continue;
      const infoY = Y.assignment[shift];
      if (!infoY || infoY.type !== "permanent" || infoY.fixed || infoY.override) continue;
      const F = permanent.find((p) => p.id === infoY.empId);
      if (!F || usedOnX.has(F.id) || F.id === eId) continue;
      if (Object.values(Y.assignment).some((v) => v.empId === eId)) continue;
      if (!F.allowedShifts.includes(shift) || ptoStatus[key(F.id, X.idx)] || ptoStatus[key(eId, Y.idx)]) continue;
      if (E.fixedDays.includes(Y.dow) || F.fixedDays.includes(X.dow)) continue;
      candidates.push({ jIdx, Y, infoY, F });
    }
    if (candidates.length === 0) return null;
    const { jIdx, Y, infoY, F } = candidates[Math.floor(Math.random() * candidates.length)];
    const trialDays = [...current];
    trialDays[dIdx] = { ...X, assignment: { ...X.assignment, [shift]: { ...infoX, empId: F.id } } };
    trialDays[jIdx] = { ...Y, assignment: { ...Y.assignment, [shift]: { ...infoY, empId: eId } } };
    const hardStreak = consecutiveHardLimit ? maxConsecutiveDays : 0;
    const withinRules = (emp) => {
      const worked = workedDayIndicesFromSchedule(trialDays, emp.id);
      return !wouldExceedShiftCap(emp, worked, [], capForBlock(emp)) && !wouldExceedConsecutiveDays(worked, [], hardStreak);
    };
    if (!withinRules(E) || !withinRules(F)) return null;
    if (!respectsFixedDayRestriction(E, [Y.dow]) || !respectsFixedDayRestriction(F, [X.dow])) return null;
    return trialDays;
  };

  // Fills an empty shift on one day with a trained person who's free that
  // day, by moving them off a nearby day's shift. A colleague who's free
  // that nearby day and trained for that shift takes over the old slot, so
  // no other shift loses coverage. Only accepted if the score improves.
  const proposeFill = (current) => {
    const holeDays = current.filter((d) => holesOnDay(d).some((s) => !isContinuityCode(s)));
    if (holeDays.length === 0) return null;
    const X = holeDays[Math.floor(Math.random() * holeDays.length)];
    const xIdx = current.indexOf(X);
    const fillable = holesOnDay(X).filter((s) => !isContinuityCode(s));
    const H = fillable[Math.floor(Math.random() * fillable.length)];
    const usedOnX = new Set(Object.values(X.assignment).map((v) => v.empId));
    const hardStreak = consecutiveHardLimit ? maxConsecutiveDays : 0;
    const withinRules = (trialDays, emp) => {
      const worked = workedDayIndicesFromSchedule(trialDays, emp.id);
      return !wouldExceedShiftCap(emp, worked, [], capForBlock(emp)) && !wouldExceedConsecutiveDays(worked, [], hardStreak);
    };
    // First choice: someone already free that day and trained for the
    // empty shift — just add them, nobody else has to move.
    const free = permanent.filter((p) => !usedOnX.has(p.id) && p.allowedShifts.includes(H)
      && !ptoStatus[key(p.id, X.idx)] && !p.fixedDays.includes(X.dow) && respectsFixedDayRestriction(p, [X.dow]));
    for (let k = free.length - 1; k > 0; k--) {
      const m = Math.floor(Math.random() * (k + 1));
      [free[k], free[m]] = [free[m], free[k]];
    }
    for (const P of free) {
      const trialDays = [...current];
      trialDays[xIdx] = { ...X, assignment: { ...X.assignment, [H]: { empId: P.id, type: "permanent", override: false, fixed: false } } };
      if (withinRules(trialDays, P)) return trialDays;
    }
    // Second choice: move someone off a nearby day, and have a colleague
    // take over that slot.
    const candidates = [];
    for (let j = Math.max(0, xIdx - 3); j <= Math.min(current.length - 1, xIdx + 3); j++) {
      if (j === xIdx || current[j].isWknd !== X.isWknd) continue;
      Object.entries(current[j].assignment).forEach(([S, infoY]) => {
        if (infoY.type === "permanent" && !infoY.fixed && !infoY.override && !isContinuityCode(S)) candidates.push({ j, S, infoY });
      });
    }
    for (let k = candidates.length - 1; k > 0; k--) {
      const m = Math.floor(Math.random() * (k + 1));
      [candidates[k], candidates[m]] = [candidates[m], candidates[k]];
    }
    for (const { j, S, infoY } of candidates) {
      const Y = current[j];
      const P = permanent.find((p) => p.id === infoY.empId);
      if (!P || usedOnX.has(P.id) || !P.allowedShifts.includes(H) || ptoStatus[key(P.id, X.idx)]) continue;
      if (P.fixedDays.includes(X.dow) || !respectsFixedDayRestriction(P, [X.dow])) continue;
      const replacements = permanent.filter((q) => q.id !== P.id && q.allowedShifts.includes(S)
        && !ptoStatus[key(q.id, Y.idx)] && !q.fixedDays.includes(Y.dow)
        && !Object.values(Y.assignment).some((v) => v.empId === q.id));
      if (replacements.length === 0) continue;
      const Q = replacements[Math.floor(Math.random() * replacements.length)];
      const trialDays = [...current];
      trialDays[xIdx] = { ...X, assignment: { ...X.assignment, [H]: { empId: P.id, type: "permanent", override: false, fixed: false } } };
      trialDays[j] = { ...Y, assignment: { ...Y.assignment, [S]: { empId: Q.id, type: "permanent", override: false, fixed: false } } };
      if (!withinRules(trialDays, P) || !withinRules(trialDays, Q)) continue;
      if (!respectsFixedDayRestriction(Q, [Y.dow])) continue;
      return trialDays;
    }
    return null;
  };

  const localSearch = (initialDays, iterations = 2500) => {
    let current = initialDays.map((d) => ({ ...d, assignment: { ...d.assignment } }));
    let currentCost = costOf(current, current.length);
    for (let i = 0; i < iterations; i++) {
      const dIdx = Math.floor(Math.random() * current.length);
      const day = current[dIdx];
      const entries = Object.entries(day.assignment).filter(([shift, info]) => info.type === "permanent" && !info.fixed && !info.override && !isContinuityCode(shift));
      const r = Math.random();
      const shapingOn = groupDaysOff || avoidLonelyShifts;
      const anyEmpty = current.some((d) => holesOnDay(d).some((s) => !isContinuityCode(s)));
      const moveType = anyEmpty && r < 0.2 ? "D" : shapingOn ? (r < 0.5 ? "A" : r < 0.75 ? "B" : "C") : (r < 0.6 ? "A" : "B");
      if (moveType === "D") {
        const trialDays = proposeFill(current);
        if (!trialDays) continue;
        const trialCost = costOf(trialDays, current.length);
        if (trialCost <= currentCost) { current = trialDays; currentCost = trialCost; }
        continue;
      }
      if (moveType === "C") {
        if (entries.length === 0) continue;
        const trialDays = proposeDayTrade(current, dIdx, entries);
        if (!trialDays) continue;
        const trialCost = costOf(trialDays, current.length);
        if (trialCost <= currentCost) { current = trialDays; currentCost = trialCost; }
        continue;
      }
      let trialAssignment = { ...day.assignment };
      let mutated = false;

      if (moveType === "A" && entries.length >= 2) {
        const idx1 = Math.floor(Math.random() * entries.length);
        let idx2 = Math.floor(Math.random() * entries.length);
        while (idx2 === idx1) idx2 = Math.floor(Math.random() * entries.length);
        const [shift1, info1] = entries[idx1];
        const [shift2, info2] = entries[idx2];
        // A swap only ever made sense before because any permanent
        // employee could work any shift — now that training restricts
        // that, confirm both people are actually qualified for the shift
        // they'd be swapped INTO before trying it.
        const emp1 = permanent.find((e) => e.id === info1.empId);
        const emp2 = permanent.find((e) => e.id === info2.empId);
        if (emp2?.allowedShifts.includes(shift1) && emp1?.allowedShifts.includes(shift2)) {
          trialAssignment[shift1] = { ...info1, empId: info2.empId };
          trialAssignment[shift2] = { ...info2, empId: info1.empId };
          mutated = true;
        }
      } else if (moveType === "B" && entries.length >= 1) {
        const [shiftX, infoX] = entries[Math.floor(Math.random() * entries.length)];
        const usedIds = new Set(Object.values(day.assignment).map((v) => v.empId));
        const candidatesY = permanent.filter((e) => !usedIds.has(e.id) && !e.fixedDays.includes(day.dow) && !ptoStatus[key(e.id, day.idx)]
          && e.allowedShifts.includes(shiftX)
          && !wouldExceedShiftCap(e, workedDayIndicesFromSchedule(current, e.id), [day.idx], capForBlock(e))
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
      const workedIdx = daysArr.filter((d) => Object.values(d.assignment).some((a) => a.empId === emp.id)).map((d) => d.idx);
      const peak = maxShiftsInAnyPayPeriod(workedIdx, windowDays);
      if (peak > maxShifts) violations.push(`${emp.name}: ${peak} shifts in one ${windowDays}-day pay period (cap is ${maxShifts})`);
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

  // Confirms assignWeekendPairs actually achieved what it tried for: the
  // same permanent person on the same shift code, both Saturday and
  // Sunday. When nobody could cover both days, the regular walk (or PRN)
  // may have filled the two days differently — that's the approved
  // best-effort fallback, not a bug, but the manager should be able to
  // see exactly where it happened.
  const verifyWeekendPairing = (daysArr) => {
    const violations = [];
    for (let i = 0; i < daysArr.length; i++) {
      const sat = daysArr[i];
      if (sat.dow !== 6) continue;
      const sun = daysArr[i + 1];
      if (!sun || sun.dow !== 0) continue;
      weekendShifts.filter((s) => !isContinuityCode(s)).forEach((code) => {
        const satInfo = sat.assignment[code];
        const sunInfo = sun.assignment[code];
        if (!satInfo || !sunInfo || satInfo.type !== "permanent" || sunInfo.type !== "permanent") return;
        if (satInfo.empId === sunInfo.empId) return;
        const satName = permanent.find((e) => e.id === satInfo.empId)?.name || "someone";
        const sunName = permanent.find((e) => e.id === sunInfo.empId)?.name || "someone";
        violations.push(`${shiftLabel(code)} on ${sat.wd} ${sat.md}–${sun.wd} ${sun.md}: ${satName} worked Saturday, ${sunName} worked Sunday`);
      });
    }
    return violations;
  };

  // Everything the Fairness Report, Optimization tab, and the schedule's
  // own violation banners show — derived purely from a finished day array,
  // with no idea whether that array came out of the optimizer or a manual
  // drag-and-drop edit. Both generate() and applyManualSwap() call this,
  // so every report always matches whatever's actually on the grid.
  const buildScheduleDerived = (finalDays) => {
    const totalDays = finalDays.length;
    let totalHoles = 0, totalOverrides = 0;
    finalDays.forEach((d) => {
      totalHoles += d.holes.length;
      Object.values(d.assignment).forEach((info) => { if (info.override) totalOverrides++; });
    });
    const finalStats = computeStats(finalDays);
    const fairness = permanent.map((e) => {
      const st = finalStats[e.id];
      const offDays = finalDays.filter((d) => !Object.values(d.assignment).some((a) => a.empId === e.id) && ptoStatus[key(e.id, d.idx)] !== "PTO1" && ptoStatus[key(e.id, d.idx)] !== "PTO2").length;
      const pto1Days = finalDays.filter((d) => ptoStatus[key(e.id, d.idx)] === "PTO1").length;
      const pto2Honored = finalDays.filter((d) => ptoStatus[key(e.id, d.idx)] === "PTO2" && !Object.values(d.assignment).some((a) => a.empId === e.id && a.override)).length;
      const pto2Overridden = finalDays.filter((d) => ptoStatus[key(e.id, d.idx)] === "PTO2" && Object.values(d.assignment).some((a) => a.empId === e.id && a.override)).length;
      const wd = st.weekendDaysWorked;
      let maxGap = wd.length === 0 ? totalDays : wd[0];
      for (let i = 1; i < wd.length; i++) maxGap = Math.max(maxGap, wd[i] - wd[i - 1]);
      if (wd.length) maxGap = Math.max(maxGap, totalDays - 1 - wd[wd.length - 1]);
      const weekendRuleBroken = totalDays > 28 && maxGap > 28;
      const hasAvailability = finalDays.some((d) => ptoStatus[key(e.id, d.idx)] !== "PTO1");
      const missingShifts = hasAvailability ? weekdayShifts.filter((s) => e.allowedShifts.includes(s) && st.shiftCount[s] === 0) : [];
      const longestRun = longestConsecutiveRun(st.workedDays);
      const longestRunExceeded = maxConsecutiveDays > 0 && longestRun > maxConsecutiveDays;
      const workedSet = new Set(st.workedDays);
      const freeIdx = finalDays.filter((d) => !workedSet.has(d.idx) && !ptoStatus[key(e.id, d.idx)]).map((d) => d.idx);
      const lonelyDaysOff = countLonelyDaysOff(st.workedDays, freeIdx);
      const lonelyShifts = countLonelyShifts(st.workedDays, finalDays.length);
      // How many times this employee got the exact same shift code
      // again before clearing the N-turn cooldown — the "was it evenly
      // spaced out" check, same N Regenerate-N itself aims for (see
      // codeRepeatCooldown), computed here against whatever's actually
      // on the grid, regardless of what produced it.
      const repeatGaps = codeRepeatGaps(st.workedDays, (dayIdx) => st.codeByDay[dayIdx]);
      const effectiveCooldown = codeRepeatCooldown ?? rotationCodes.length;
      const earlyRepeats = repeatGaps.filter((g) => g !== null && g < effectiveCooldown).length;
      return { id: e.id, name: e.name, fixedDays: e.fixedDays, shiftCap: e.shiftCap || null, allowedShifts: e.allowedShifts, total: st.totalWorked, perShift: st.shiftCount, offDays, pto1Days, pto2Honored, pto2Overridden, weekendCount: st.weekendCount, weekendRuleBroken, missingShifts, longestRun, longestRunExceeded, lonelyDaysOff, lonelyShifts, earlyRepeats };
    });
    const extraFairness = extra.map((e) => {
      const total = finalDays.reduce((sum, d) => sum + Object.values(d.assignment).filter((a) => a.empId === e.id && a.type === "extra").length, 0);
      return { id: e.id, name: e.name, allowedShifts: e.allowedShifts, total };
    });

    const continuityCheck = verifyContinuity(finalDays);
    const employeesMissingShifts = fairness.filter((f) => f.missingShifts.length > 0).length;
    const shiftCapViolations = verifyShiftCaps(finalDays);
    const cappedFixedDayViolations = verifyCappedFixedDays(finalDays);
    const weekendPairingMismatches = weekendPairingEnabled ? verifyWeekendPairing(finalDays) : [];
    // Pay-period shortfalls the guarantee top-up couldn't resolve without
    // breaking the consecutive-day hard limit — flagged on the grid (the
    // red "!" badge) rather than silently shipped short. One flag per
    // unresolved pay period, so this is a direct count of what needs a
    // manager's manual call.
    const guaranteeGaps = finalDays.reduce((sum, d) => sum + Object.values(d.assignment).filter((a) => a.phantom).length, 0);

    return { days: finalDays, fairness, extraFairness, totalHoles, totalOverrides, continuityCheck, employeesMissingShifts, shiftCapViolations, cappedFixedDayViolations, weekendPairingMismatches, guaranteeGaps };
  };

  // Tops every extended-hour employee up to their guaranteed shift count
  // — the actual enforcement behind the checkbox. Runs once, after the
  // optimizer is completely done, over whatever it produced; each person
  // is topped up to exactly their own shortfall and nobody else's, which
  // is what keeps this fair without needing a separate balancing step —
  // nobody can ever get more E0 than their own gap requires. Skipped
  // entirely if the overflow shift is missing or paused, so pausing it
  // is the off-switch for this whole feature. Wherever a day being
  // topped up has a real hole, or a PRN person covering a shift this
  // employee is trained for, that's used instead of E0 — there's no
  // reason to pad someone's hours with a placeholder, or keep paying for
  // PRN coverage, on a day a permanent person who needs more hours could
  // do the actual job.
  const applyMinimumShiftGuarantees = (daysIn) => {
    const overflowDef = shiftDefByCode[OVERFLOW_CODE];
    if (!overflowDef || overflowDef.collapsed) return daysIn;
    let days = daysIn;

    // A real shift this person is trained for always beats a generic E0
    // filler, on that same day, two ways at once: it counts toward their
    // guarantee AND covers actual need instead of padding hours — so
    // there's no reason to call in (or keep) PRN on a day someone who
    // needs more hours could cover it directly. Prefer an outright hole
    // first, then a PRN-covered shift to take over; only fall back to E0
    // when neither exists.
    const applyPick = (employee, dayIdx) => {
      days = days.map((d) => {
        if (d.idx !== dayIdx) return d;
        const holeCode = d.holes.find((code) => employee.allowedShifts.includes(code));
        const prnEntry = Object.entries(d.assignment).find(([code, info]) => info.type === "extra" && employee.allowedShifts.includes(code));
        const newAssignment = { ...d.assignment };
        if (holeCode) newAssignment[holeCode] = { empId: employee.id, type: "permanent", override: false, fixed: false };
        else if (prnEntry) newAssignment[prnEntry[0]] = { empId: employee.id, type: "permanent", override: false, fixed: false };
        else newAssignment[nextOverflowKey(d.assignment)] = { empId: employee.id, type: "permanent", override: false, fixed: false };
        return { ...d, assignment: newAssignment, holes: holesOnDay({ ...d, assignment: newAssignment }) };
      });
    };

    const blockCandidates = (employee, blockStart, blockEnd) => {
      const worked = new Set(workedDayIndicesFromSchedule(days, employee.id));
      return days.slice(blockStart, blockEnd)
        .filter((d) => {
          if (worked.has(d.idx)) return false;
          const st = ptoStatus[key(employee.id, d.idx)];
          if (st === "PTO1" || st === "PTO2") return false;
          return respectsFixedDayRestriction(employee, [d.dow]);
        })
        .map((d) => d.idx);
    };

    // Fills just this one pay-period block up to target, same acceptance
    // rules as the main pass. Reused both for the initial top-up and to
    // recover a block that the run-reshaping repair below just took a day
    // away from.
    const topUpBlock = (employee, blockStart, windowDays, target) => {
      const blockEnd = Math.min(blockStart + windowDays, days.length);
      const worked = workedDayIndicesFromSchedule(days, employee.id);
      if (worked.filter((idx) => idx >= blockStart && idx < blockEnd).length >= target) return;
      const picks = pickOverflowDays(
        worked, blockCandidates(employee, blockStart, blockEnd), days.length, windowDays, target,
        (idx, runningWorked) => !wouldExceedShiftCap(employee, runningWorked, [idx], capForBlock(employee))
          && !(consecutiveHardLimit && wouldExceedConsecutiveDays(runningWorked, [idx], maxConsecutiveDays))
      );
      picks.forEach((idx) => applyPick(employee, idx));
    };

    // Someone other than `employee` who could safely take over `code` on
    // `dayIdx` instead — trained, available, and (if capped themselves)
    // wouldn't bust their OWN pay-period cap or consecutive-day limit by
    // taking it. Permanent staff first; PRN is still a fallback since
    // displacing them to free up a guaranteed-hours day is the same trade
    // the normal top-up already makes.
    const findReplacement = (employee, dayIdx, code) => {
      const day = days.find((d) => d.idx === dayIdx);
      const used = new Set(Object.values(day.assignment).map((a) => a.empId));
      const perm = permanent.find((p) => p.id !== employee.id && !used.has(p.id) && p.allowedShifts.includes(code)
        && ptoStatus[key(p.id, dayIdx)] !== "PTO1" && ptoStatus[key(p.id, dayIdx)] !== "PTO2"
        && respectsFixedDayRestriction(p, [day.dow])
        && !wouldExceedShiftCap(p, workedDayIndicesFromSchedule(days, p.id), [dayIdx], capForBlock(p))
        && !(consecutiveHardLimit && wouldExceedConsecutiveDays(workedDayIndicesFromSchedule(days, p.id), [dayIdx], maxConsecutiveDays)));
      if (perm) return { empId: perm.id, type: "permanent" };
      const ex = extra.find((x) => !used.has(x.id) && x.allowedShifts.includes(code) && extraAvailable[key(x.id, dayIdx)]);
      return ex ? { empId: ex.id, type: "extra" } : null;
    };

    // Applies the donor's side of a pickPhantomPermanentSwap plan
    // (their new, real replacement shift) and hands back the
    // {dayIdx, code} the caller still needs to assign to the phantom-
    // flagged employee. The decision itself lives in
    // pickPhantomPermanentSwap so it's covered by unit tests; this is
    // just the `days` mutation.
    const applyPermanentCushionSwap = (candidates, e) => {
      const plan = pickPhantomPermanentSwap(
        candidates, (dayIdx) => { const d = days.find((dd) => dd.idx === dayIdx); return { assignment: d.assignment, holes: d.holes }; },
        e.allowedShifts, cushionShiftCodes, e.id, (empId) => permanent.find((p) => p.id === empId)?.allowedShifts, isContinuityCode
      );
      if (!plan) return null;
      days = days.map((d) => {
        if (d.idx !== plan.dayIdx) return d;
        const na = { ...d.assignment, [plan.replacementCode]: { empId: plan.donorId, type: "permanent", override: false, fixed: false } };
        return { ...d, assignment: na, holes: holesOnDay({ ...d, assignment: na }) };
      });
      return { dayIdx: plan.dayIdx, code: plan.code };
    };

    permanent.filter((e) => e.shiftCap).forEach((e) => {
      const { windowDays, maxShifts } = e.shiftCap;
      const targetForBlock = (blockStart) => guaranteeTargetForBlock(ptoStatus, ptoSource, e.id, blockStart, Math.min(blockStart + windowDays, days.length), maxShifts);
      for (let b = 0; b < days.length; b += windowDays) topUpBlock(e, b, windowDays, targetForBlock(b));

      // Anything still short at this point was blocked purely by the
      // consecutive-day hard limit — not enough open days to add more
      // without a run forming that's too long. Reshape the run instead of
      // giving up on the shortfall: hand ONE of this employee's own days
      // within that run to someone else who can safely take it, then
      // retry the blocked day. If that leaves the donated day's own block
      // short, top it back up the same way before moving on.
      if (consecutiveHardLimit) {
        for (let b = 0; b < days.length; b += windowDays) {
          const blockEnd = Math.min(b + windowDays, days.length);
          let worked = workedDayIndicesFromSchedule(days, e.id);
          let count = worked.filter((idx) => idx >= b && idx < blockEnd).length;
          if (count >= targetForBlock(b)) continue;
          for (const dayIdx of blockCandidates(e, b, blockEnd)) {
            if (count >= targetForBlock(b)) break;
            if (!wouldExceedConsecutiveDays(worked, [dayIdx], maxConsecutiveDays)) continue; // not actually blocked
            const sorted = [...worked, dayIdx].sort((x, y) => x - y);
            const at = sorted.indexOf(dayIdx);
            let lo = at, hi = at;
            while (lo > 0 && sorted[lo - 1] === sorted[lo] - 1) lo--;
            while (hi < sorted.length - 1 && sorted[hi + 1] === sorted[hi] + 1) hi++;
            // A pivot has to come from a DIFFERENT pay-period block than
            // the one we're trying to fill — donating a day from inside
            // this same block just moves which day counts toward it, not
            // how many do.
            const runDays = sorted.slice(lo, hi + 1).filter((idx) => idx !== dayIdx && (idx < b || idx >= blockEnd));
            for (const pivotIdx of runDays) {
              if (wouldExceedConsecutiveDays(worked.filter((idx) => idx !== pivotIdx), [dayIdx], maxConsecutiveDays)) continue;
              const pivotDay = days.find((d) => d.idx === pivotIdx);
              const pivotEntry = Object.entries(pivotDay.assignment).find(([, info]) => info.empId === e.id);
              // Never touch a continuity/weekend-pairing commitment (fixed),
              // and never hand off a continuity-code shift at all even if
              // this one instance isn't marked fixed — giving the
              // replacement just this one day would itself be a fresh
              // continuity-run violation (that code needs 2-3 days in a
              // row, not a lone day from whoever picks it up).
              if (!pivotEntry || pivotEntry[1].fixed || isContinuityCode(pivotEntry[0])) continue;
              const replacement = findReplacement(e, pivotIdx, pivotEntry[0]);
              if (!replacement) continue;
              days = days.map((d) => {
                if (d.idx !== pivotIdx) return d;
                const na = { ...d.assignment };
                na[pivotEntry[0]] = { empId: replacement.empId, type: replacement.type, override: false, fixed: false };
                return { ...d, assignment: na, holes: holesOnDay({ ...d, assignment: na }) };
              });
              applyPick(e, dayIdx);
              const pivotBlockStart = Math.floor(pivotIdx / windowDays) * windowDays;
              topUpBlock(e, pivotBlockStart, windowDays, targetForBlock(pivotBlockStart));
              worked = workedDayIndicesFromSchedule(days, e.id);
              count = worked.filter((idx) => idx >= b && idx < blockEnd).length;
              break;
            }
          }
        }
      }

      // Whatever's STILL short is a genuine conflict between hard rules —
      // usually the consecutive-day limit colliding with a fixed
      // commitment (weekend pairing, continuity) sitting right at a
      // pay-period boundary — that can't be resolved without relaxing one
      // of them. Flag it rather than silently shipping an incomplete
      // guarantee: mark one open day in that period as needing manual
      // coverage. It counts toward the displayed total, same as a real
      // pick, so the shortfall is visible in the Shifts column instead of
      // just quietly missing.
      //
      // Which day/code gets flagged prefers the manager's chosen
      // "cushion" code (a float role, usually easier than the rest)
      // above everything else, tried in order: take it over from a PRN
      // already covering it, claim it directly on a day nobody's using
      // it yet, or take it from a PERMANENT employee instead as long
      // as THEY can be handed something real in return that same day
      // (never left with a bare E0). Only once none of that works
      // anywhere in the block does this fall back to displacing any
      // PRN's real shift regardless of cushion (still better than a
      // placeholder), and only once THAT fails too does it settle for
      // a plain E0 filler on the first open day.
      for (let b = 0; b < days.length; b += windowDays) {
        const blockEnd = Math.min(b + windowDays, days.length);
        const worked = workedDayIndicesFromSchedule(days, e.id);
        if (worked.filter((idx) => idx >= b && idx < blockEnd).length >= targetForBlock(b)) continue;
        const candidates = blockCandidates(e, b, blockEnd);
        if (candidates.length === 0) continue;
        const getDay = (dayIdx) => days.find((d) => d.idx === dayIdx);
        const pick = pickPhantomCushionSlot(candidates, getDay, e.allowedShifts, cushionShiftCodes, isContinuityCode)
          || applyPermanentCushionSwap(candidates, e)
          || pickPhantomAnySteal(candidates, getDay, e.allowedShifts, isContinuityCode);
        const openDay = pick ? pick.dayIdx : candidates[0];

        days = days.map((d) => {
          if (d.idx !== openDay) return d;
          const newAssignment = { ...d.assignment };
          newAssignment[pick ? pick.code : nextOverflowKey(d.assignment)] = { empId: e.id, type: "permanent", override: false, fixed: false, phantom: true };
          return { ...d, assignment: newAssignment, holes: holesOnDay({ ...d, assignment: newAssignment }) };
        });
      }
    });
    return days;
  };

  const generate = () => {
    if (schedule) setUndoStack((s) => [...s.slice(-(UNDO_LIMIT - 1)), schedule]);
    setGenerating(true);
    setTimeout(() => {
      const stats = {};
      permanent.forEach((e) => { stats[e.id] = { totalWorked: 0, shiftCount: Object.fromEntries(ALL_SHIFT_CODES.map((s) => [s, 0])), weekendCount: 0, weekendDaysWorked: [], workedDays: [] }; });
      const extraStats = {};
      extra.forEach((e) => { extraStats[e.id] = { totalWorked: 0 }; });

      // Manual shift pins (Permanent Staff tab PTO grid) are decided
      // before anything else in the whole generation pass — they're the
      // most specific, deliberate commitment a manager can make (exact
      // employee, exact day, exact code), so continuity blocks, weekend
      // pairing, forced holiday tags, and the regular walk all have to
      // work AROUND a pin rather than racing it for the slot. Skips (and
      // flags) a pin that collides with approved PTO-1, another pin
      // already claiming that exact code that day (never silently bumps
      // one pin for another), or the employee's own hard shift cap. A pin
      // for a code the employee isn't trained for is still honored — it's
      // the manager's explicit choice — but flagged, since that's more
      // likely a slip than an intended cross-training override.
      const pinnedByDay = {};
      const pinnedConflicts = [];
      const pinnedWarnings = [];
      const pinnedDaysByEmp = {};
      permanent.forEach((e) => { pinnedDaysByEmp[e.id] = []; });
      permanent.forEach((e) => {
        days.forEach((day) => {
          const code = pinnedShifts[key(e.id, day.idx)];
          if (!code) return;
          if (ptoStatus[key(e.id, day.idx)] === "PTO1") {
            pinnedConflicts.push(`${e.name} is pinned to ${shiftLabel(code)} on ${day.wd} ${day.md}, but has approved PTO-1 that day — not scheduled.`);
            return;
          }
          if (pinnedByDay[day.idx]?.[code]) {
            pinnedConflicts.push(`${e.name} is pinned to ${shiftLabel(code)} on ${day.wd} ${day.md}, but someone else is already pinned to that exact shift that day — not scheduled. Reassign one of them first or pick a different code.`);
            return;
          }
          if (wouldExceedShiftCap(e, pinnedDaysByEmp[e.id], [day.idx])) {
            pinnedConflicts.push(`${e.name} is pinned to ${shiftLabel(code)} on ${day.wd} ${day.md}, but that would push them over their shift cap for that pay period — not scheduled. Free up that period or pick a different date.`);
            return;
          }
          if (!e.allowedShifts.includes(code)) {
            pinnedWarnings.push(`${e.name} isn't trained on ${shiftLabel(code)}, pinned for ${day.wd} ${day.md} anyway since you chose it directly.`);
          }
          pinnedByDay[day.idx] = { ...pinnedByDay[day.idx], [code]: { empId: e.id, type: "permanent", override: false, fixed: true, pinned: true } };
          pinnedDaysByEmp[e.id].push(day.idx);
        });
      });

      const continuityByCode = {};
      const continuityCommittedDays = {};
      // A day an employee is already pinned to (any code) is claimed
      // before continuity ever looks at them, so a block built for a
      // DIFFERENT code can't double-book that day.
      permanent.forEach((e) => { if (pinnedDaysByEmp[e.id].length) continuityCommittedDays[`p:${e.id}`] = new Set(pinnedDaysByEmp[e.id]); });
      Object.entries(continuityRules).forEach(([code, rule]) => { continuityByCode[code] = assignContinuityBlocks(code, rule, continuityCommittedDays, pinnedByDay, pinnedDaysByEmp); });
      const continuityDaysByEmp = {};
      permanent.forEach((e) => { continuityDaysByEmp[e.id] = []; });
      days.forEach((day) => {
        Object.values(continuityByCode).forEach((map) => {
          const entry = map[day.idx];
          if (entry && entry.type === "permanent") continuityDaysByEmp[entry.empId].push(day.idx);
        });
      });

      // Switched off: skip the pairing pre-pass entirely, so weekends get
      // filled by the normal per-day walk like any other day — same empty
      // shape the pre-pass itself would return if nobody was eligible.
      const { dayAssignment: weekendPaired, workedDaysByEmp: weekendPairedDays } = weekendPairingEnabled
        ? assignWeekendPairs(continuityDaysByEmp, pinnedByDay, pinnedDaysByEmp)
        : { dayAssignment: {}, workedDaysByEmp: Object.fromEntries(permanent.map((e) => [e.id, []])) };

      // "Force holiday (hard)" tags (Permanent Staff tab) are decided the
      // same way, up front, for the whole rotation — a specific employee
      // guaranteed a real shift on a specific date even if it would
      // normally be their day off, for sparse holiday coverage. Skips
      // (and flags) a tag that collides with approved PTO-1, or where
      // nobody active that day matches their training — it never
      // overrides approved leave, and never invents a shift from
      // nothing. Also skips anyone already committed that day via
      // continuity, weekend pairing, or a manual pin — they're already
      // guaranteed to work it, nothing more to force.
      //
      // Also checked against the employee's own hard cap before ever
      // committing it — "always wins" never means "always exceeds the
      // cap"; that one's non-negotiable. A continuity block, a
      // weekend-pairing commitment, or a manual pin already locked in
      // for the same pay period (decided above, before any forced tag is
      // looked at) counts toward this, same as a forced tag processed
      // earlier in this same pass for the same employee — so two forced
      // tags that alone would blow past the cap, or one that collides
      // with a continuity run nobody else can cover, gets flagged
      // instead of silently violating it. This checks the real flat cap,
      // not the PTO-reduced guarantee target — forcing someone in is
      // about the hard ceiling, not how few shifts their PTO says they
      // still need.
      const forcedByDay = {};
      const forcedConflicts = [];
      const forcedDaysByEmp = {};
      permanent.forEach((e) => { forcedDaysByEmp[e.id] = []; });
      permanent.forEach((e) => {
        days.forEach((day) => {
          if (!forcedHolidayWork[key(e.id, day.idx)]) return;
          if (ptoStatus[key(e.id, day.idx)] === "PTO1") {
            forcedConflicts.push(`${e.name} is tagged to force-work ${day.wd} ${day.md}, but has approved PTO-1 that day — not scheduled.`);
            return;
          }
          const alreadyCommitted = Object.values(continuityByCode).some((map) => map[day.idx]?.empId === e.id)
            || Object.values(weekendPaired[day.idx] || {}).some((info) => info.empId === e.id)
            || !!pinnedByDay[day.idx] && Object.values(pinnedByDay[day.idx]).some((info) => info.empId === e.id);
          if (alreadyCommitted) return;
          const existingWorked = [...continuityDaysByEmp[e.id], ...weekendPairedDays[e.id], ...pinnedDaysByEmp[e.id], ...forcedDaysByEmp[e.id]];
          if (wouldExceedShiftCap(e, existingWorked, [day.idx])) {
            forcedConflicts.push(`${e.name} is tagged to force-work ${day.wd} ${day.md}, but that would push them over their shift cap for that pay period — likely colliding with a continuity block, a weekend-pairing commitment, a manual pin, or another forced tag already locked in that period — not scheduled. Free up that period or pick a different date.`);
            return;
          }
          const isWknd = day.isWeekend || holidays.has(day.iso);
          const activeShifts = isWknd ? weekendShifts : weekdayShifts;
          const isTaken = (code) => !!continuityByCode[code]?.[day.idx] || !!weekendPaired[day.idx]?.[code] || !!pinnedByDay[day.idx]?.[code] || !!forcedByDay[day.idx]?.[code];
          const code = pickForcedHolidayCode(activeShifts, e.allowedShifts, isContinuityCode, isTaken);
          if (!code) {
            forcedConflicts.push(`${e.name} is tagged to force-work ${day.wd} ${day.md}, but isn't trained for anything that runs that day — not scheduled.`);
            return;
          }
          forcedByDay[day.idx] = { ...forcedByDay[day.idx], [code]: { empId: e.id, type: "permanent", override: false, fixed: true, forcedHoliday: true } };
          forcedDaysByEmp[e.id].push(day.idx);
        });
      });

      // Continuity blocks, paired weekend days, manual pins, and forced
      // holiday work are all decided for the WHOLE rotation in one shot
      // above, before any regular-day assignment happens. Seed the cap
      // trackers with all of it up front — otherwise a regular shift
      // handed out early in the walk wouldn't "know" about a commitment
      // already locked in for this person two weeks later, and the two
      // together could quietly blow past their cap. PRN has its own
      // tracker since their cap (if any) is separate from permanent
      // staff's.
      const capWorkedDays = {};
      permanent.forEach((e) => { capWorkedDays[e.id] = [...continuityDaysByEmp[e.id], ...weekendPairedDays[e.id], ...pinnedDaysByEmp[e.id], ...forcedDaysByEmp[e.id]]; });
      const extraCapWorkedDays = {};
      extra.forEach((e) => { extraCapWorkedDays[e.id] = []; });
      days.forEach((day) => {
        Object.values(continuityByCode).forEach((map) => {
          const entry = map[day.idx];
          if (entry && entry.type === "extra") extraCapWorkedDays[entry.empId].push(day.idx);
        });
      });

      // Yesterday's shift per employee, permanent staff only — deleted for
      // anyone who doesn't work today, so an off day correctly breaks the
      // "back to back" adjacency for whichever day they next work.
      const prevShiftByEmp = {};
      const initialDays = days.map((day) => {
        const preToday = {};
        Object.entries(continuityByCode).forEach(([code, map]) => { if (map[day.idx]) preToday[code] = map[day.idx]; });
        if (weekendPaired[day.idx]) Object.entries(weekendPaired[day.idx]).forEach(([shift, entry]) => { preToday[shift] = entry; });
        if (pinnedByDay[day.idx]) Object.entries(pinnedByDay[day.idx]).forEach(([shift, entry]) => { preToday[shift] = entry; });
        if (forcedByDay[day.idx]) Object.entries(forcedByDay[day.idx]).forEach(([shift, entry]) => { preToday[shift] = entry; });
        Object.entries(preToday).forEach(([shift, entry]) => {
          if (entry.type === "permanent") {
            const st = stats[entry.empId];
            st.totalWorked++; st.shiftCount[shift]++; st.workedDays.push(day.idx);
            const isWknd = day.isWeekend || holidays.has(day.iso);
            if (isWknd) { st.weekendCount++; st.weekendDaysWorked.push(day.idx); }
          } else { extraStats[entry.empId].totalWorked++; }
        });
        const result = assignDay(day, stats, extraStats, preToday, capWorkedDays, extraCapWorkedDays, prevShiftByEmp);
        const workedTodayByEmp = new Set();
        Object.entries(result.assignment).forEach(([shift, info]) => {
          if (info.type === "permanent") {
            prevShiftByEmp[info.empId] = { dayIdx: day.idx, dow: day.dow, shift };
            workedTodayByEmp.add(info.empId);
          }
        });
        permanent.forEach((e) => { if (!workedTodayByEmp.has(e.id)) delete prevShiftByEmp[e.id]; });
        return result;
      });

      const costBefore = costOf(initialDays, initialDays.length);
      const { days: searchedDays, finalCost: costAfter } = localSearch(initialDays, 2500);
      const optimizedDays = applyMinimumShiftGuarantees(searchedDays.map((d) => ({ ...d, holes: holesOnDay(d) })));

      // The optimizer (localSearch's fairness-balancing swaps, and the
      // guarantee top-up's PRN displacement) can hand someone's shift to
      // a different person without the two trading anything back — the
      // same kind of loss a manual drag can cause, just made internally
      // across thousands of trial moves instead of one click. Comparing
      // the day-walk's first pass (initialDays, before any of that ran)
      // against the final result finds every day that changed hands this
      // way, regardless of which internal move caused it.
      //
      // Only worth flagging when it actually cost someone a NET shift,
      // though — across 2500 local-search trials it's common for someone
      // to lose one day's shift but pick up a different one elsewhere in
      // the same pass, landing at the same total. That's just their days
      // reshuffling, not a loss, so it's excluded here: only employees
      // whose final total is actually lower than where the day-walk first
      // left them get reported, same bar the manual-drag warning uses
      // (its own "down to N shifts" message).
      const empList = [...permanent, ...extra];
      const totalWorked = (daysArr, empId) => daysArr.filter((d) => Object.values(d.assignment).some((a) => a.empId === empId)).length;
      const autoRearrangedLosses = [];
      const autoKickedOutCells = new Set();
      empList.forEach((e) => {
        const initialTotal = totalWorked(initialDays, e.id);
        const finalTotal = totalWorked(optimizedDays, e.id);
        if (finalTotal >= initialTotal) return;
        days.forEach((day) => {
          const before = Object.entries(initialDays[day.idx].assignment).find(([, info]) => info.empId === e.id);
          if (!before) return;
          const stillHas = Object.values(optimizedDays[day.idx].assignment).some((info) => info.empId === e.id);
          if (stillHas) return;
          autoRearrangedLosses.push(`${e.name} had ${shiftLabel(before[0])} on ${day.wd} ${day.md} before the generator reassigned it elsewhere — down to ${finalTotal} shifts total now (was ${initialTotal}).`);
          autoKickedOutCells.add(key(e.id, day.idx));
        });
      });

      const settingsUsed = { maxConsecutiveDays, consecutiveHardLimit, groupDaysOff, avoidLonelyShifts, weekendPairingEnabled, extendOffWeekends, cushionShiftCodes };
      const scheduleSnapshot = { settingsUsed, costBefore, costAfter, iterations: 2500, numWeeks, startDate, forcedHolidayConflicts: forcedConflicts, pinnedShiftConflicts: pinnedConflicts, pinnedShiftWarnings: pinnedWarnings, autoRearrangedLosses, ...buildScheduleDerived(optimizedDays) };
      setSchedule(scheduleSnapshot);
      setManualEditWarnings([]);
      setKickedOutCells(autoKickedOutCells);
      setMissingShiftCells(new Set());
      setMissingShiftReport(null);
      setDismissedAlerts(new Set());
      saveScheduleSnapshot(scheduleSnapshot, viewingOwnerId).catch(reportSyncError);
      setGenerating(false);
      setTab("schedule");
    }, 30);
  };

  // "Regenerate-N" — reshuffles the schedule that's already on screen
  // to spread shift-code repeats out more evenly; it never decides WHO
  // works WHICH DAYS. That's taken as a given from the current grid —
  // nobody's total shift count for any pay period changes, because
  // nobody's set of worked days changes. All it does is swap which
  // CODE two people already working the same day are down for, when
  // that improves spacing.
  //
  // The target: nobody should get the exact same shift code again until
  // N of their own other worked days have passed (see
  // codeRepeatCooldown) — "cycle through a full set of codes before any
  // repeat" by default, looser or stricter if a different N is picked
  // from the dropdown. This runs as a randomized search (2,500 trials,
  // same shape as the real optimizer's own local search): pick a
  // weekday at random, pick two people already working it, and swap
  // their codes only if doing so doesn't make the schedule's overall
  // spacing any worse. Weekends, holidays, pinned shifts, continuity
  // blocks, phantom (needs-manual-coverage) slots, and PRN coverage are
  // never touched — those aren't "already-working pairs" eligible to
  // swap, they're the non-negotiables. A swap also only ever happens
  // between two people each trained for the OTHER's code — nothing here
  // ever puts someone on a shift they're not qualified for.
  //
  // Because nobody's worked-day set ever changes, there's no cap,
  // PTO-1, fixed-day, or consecutive-day check needed at all — none of
  // those can be affected by swapping which code someone already
  // working today is down for. The only outcome this can't improve is
  // when nobody eligible to swap with has training for the other's
  // code; those repeats stay exactly as they were, and still show up
  // honestly in "Fairness check" as Early repeats.
  const regenerateByRotation = () => {
    if (!schedule) return;
    setUndoStack((s) => [...s.slice(-(UNDO_LIMIT - 1)), schedule]);
    setGeneratingRotation(true);
    setTimeout(() => {
      const cooldown = codeRepeatCooldown ?? rotationCodes.length;
      // Phantom (needs-manual-coverage) slots and PRN coverage are
      // locked the same as pinned shifts/continuity blocks — none of
      // these are "just a regular already-working pair" eligible to
      // swap with anyone.
      const isLocked = (info) => info.fixed || info.pinned || info.phantom || info.type === "extra";

      // Total "early repeat" severity across the whole schedule — the
      // thing each trial swap is trying to lower. A repeat 1 turn too
      // soon costs less than one 5 turns too soon, so the search can
      // tell "slightly bad" from "very bad," not just count violations.
      const spacingCost = (daysArr) => {
        let cost = 0;
        permanent.forEach((e) => {
          const worked = workedDayIndicesFromSchedule(daysArr, e.id).sort((a, b) => a - b);
          const codeForDay = (d) => {
            const entry = Object.entries(daysArr[d].assignment).find(([, info]) => info.empId === e.id);
            return entry ? overflowBaseCode(entry[0]) : null;
          };
          codeRepeatGaps(worked, codeForDay).forEach((g) => { if (g !== null) cost += Math.max(0, cooldown - g); });
        });
        return cost;
      };

      let current = schedule.days.map((d) => ({ ...d, assignment: { ...d.assignment } }));
      let currentCost = spacingCost(current);
      const weekdayIndices = current
        .map((d) => d.idx)
        .filter((idx) => current[idx].dow !== 0 && current[idx].dow !== 6 && !holidays.has(current[idx].iso));

      if (weekdayIndices.length > 0 && rotationCodes.length > 1) {
        const ITERATIONS = 2500;
        for (let iter = 0; iter < ITERATIONS; iter++) {
          const dayIdx = weekdayIndices[Math.floor(Math.random() * weekdayIndices.length)];
          const day = current[dayIdx];
          const entries = Object.entries(day.assignment).filter(([code, info]) => info.type === "permanent" && !isLocked(info) && rotationCodes.includes(code));
          if (entries.length < 2) continue;
          const i1 = Math.floor(Math.random() * entries.length);
          let i2 = Math.floor(Math.random() * entries.length);
          if (i2 === i1) i2 = (i2 + 1) % entries.length;
          const [codeA, infoA] = entries[i1];
          const [codeB, infoB] = entries[i2];
          if (infoA.empId === infoB.empId) continue;
          const empA = permanent.find((p) => p.id === infoA.empId);
          const empB = permanent.find((p) => p.id === infoB.empId);
          if (!empA || !empB || !empA.allowedShifts.includes(codeB) || !empB.allowedShifts.includes(codeA)) continue;

          const trialDays = current.slice();
          const trialDay = { ...day, assignment: { ...day.assignment } };
          const ptoA = ptoStatus[key(infoA.empId, dayIdx)] === "PTO2";
          const ptoB = ptoStatus[key(infoB.empId, dayIdx)] === "PTO2";
          trialDay.assignment[codeA] = { empId: infoB.empId, type: "permanent", override: ptoB, fixed: false };
          trialDay.assignment[codeB] = { empId: infoA.empId, type: "permanent", override: ptoA, fixed: false };
          trialDays[dayIdx] = trialDay;
          const trialCost = spacingCost(trialDays);
          if (trialCost <= currentCost) { current = trialDays; currentCost = trialCost; }
        }
      }

      const updated = { ...schedule, ...buildScheduleDerived(current), costAfter: costOf(current, current.length) };
      setSchedule(updated);
      setManualEditWarnings([]);
      setKickedOutCells(new Set());
      setMissingShiftCells(new Set());
      setMissingShiftReport(null);
      setDismissedAlerts(new Set());
      saveScheduleSnapshot(updated, viewingOwnerId).catch(reportSyncError);
      setGeneratingRotation(false);
      setTab("schedule");
    }, 30);
  };

  // Pops the most recent snapshot off the undo history and makes it the
  // active schedule again — same restore path loadFromSlot uses, so
  // it's immediately persisted too (a reload shows the undone state,
  // not what it undid). Every ephemeral highlight/alert resets, same as
  // any other full-schedule replace.
  const undoLastChange = () => {
    if (undoStack.length === 0) return;
    const previous = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    setSchedule(previous);
    setManualEditWarnings([]);
    setKickedOutCells(new Set());
    setMissingShiftCells(new Set());
    setMissingShiftReport(null);
    setDismissedAlerts(new Set());
    saveScheduleSnapshot(previous, viewingOwnerId).catch(reportSyncError);
  };

  // "Fairness check" — a pure re-scan, never a regenerate. Re-tabulates
  // every fairness number (the per-employee table, the new distribution
  // & streak summary, continuity/cap/fixed-day violations — all of
  // buildScheduleDerived) straight from whatever's on the grid right
  // now, however it got there: Regenerate-N, a drag, a gap fill, any
  // mix. Most of that already updates live on every edit — the one
  // number that doesn't is the top banner's "before optimizer" fairness
  // score, which Regenerate-N never sets and which otherwise keeps
  // showing a stale baseline from whenever Generate last actually ran.
  // This measures the CURRENT grid fresh and uses that single number
  // for both sides, with iterations zeroed out so the banner reads as
  // "this is where things stand" instead of a misleading before/after.
  // Doesn't touch a single assignment, so it isn't pushed onto the undo
  // history — there's nothing here to undo.
  const checkFairness = () => {
    if (!schedule) return;
    const freshCost = costOf(schedule.days, schedule.days.length);
    const updated = { ...schedule, ...buildScheduleDerived(schedule.days), costBefore: freshCost, costAfter: freshCost, iterations: 0 };
    setSchedule(updated);
    saveScheduleSnapshot(updated, viewingOwnerId).catch(reportSyncError);
  };

  // Manual drag-and-drop editing of an already-generated schedule. A
  // continuity-tagged shift can't be dragged or dropped onto — a
  // single-cell swap would silently break a multi-day commitment that's
  // supposed to be locked together — and a day that's someone's approved
  // PTO-1 leave can't be dropped onto either, so a slip of the mouse can't
  // quietly override it.
  const canDragCell = (code) => ALL_SHIFT_CODES.includes(code) && !isContinuityCode(code);
  const canDropOnCell = (emp, day) => {
    if (ptoStatus[key(emp.id, day.idx)] === "PTO1") return false;
    return !isContinuityCode(cellFor(emp, day).code);
  };

  // Soft, non-blocking heads-up for a swap that puts someone somewhere the
  // auto-generated schedule never would have — same philosophy as every
  // other "preference" in this app: tell the manager, don't stop them.
  // Also the GIVER's side of a move: `oldCode` is what they had on this
  // day before the drag. If they end up with nothing (`newCode` falsy)
  // and they had a real shift before, their shift count just went down
  // one — flag that here too, not just on the receiving end, so a move
  // that quietly leaves someone short doesn't only get a warning when
  // the person who GAINED the shift happens to trip a cap/training rule.
  const manualEditWarning = (newDays, emp, dayIdx, newCode, oldCode) => {
    if (!newCode) {
      if (!oldCode) return [];
      const newTotal = newDays.filter((d) => Object.values(d.assignment).some((a) => a.empId === emp.id)).length;
      return [`${emp.name} lost their ${shiftLabel(oldCode)} shift here with nothing given back — down to ${newTotal} shift${newTotal === 1 ? "" : "s"} total now.`];
    }
    const warnings = [];
    if (!emp.allowedShifts.includes(newCode)) warnings.push(`${emp.name} isn't trained on ${shiftLabel(newCode)}.`);
    if (emp.type === "permanent") {
      const workedDays = newDays.filter((d) => Object.values(d.assignment).some((a) => a.empId === emp.id)).map((d) => d.idx);
      const otherWorkedDays = workedDays.filter((idx) => idx !== dayIdx);
      if (wouldExceedShiftCap(emp, otherWorkedDays, [dayIdx], capForBlock(emp))) warnings.push(`${emp.name} is now over their shift cap.`);
      if (consecutiveHardLimit && wouldExceedConsecutiveDays(otherWorkedDays, [dayIdx], maxConsecutiveDays)) warnings.push(`${emp.name} now has too many days in a row.`);
    }
    return warnings;
  };

  // Someone other than `excludeEmpId` who could safely take over `code`
  // on `dayIdx` instead — same checks a generated schedule itself would
  // apply: trained, available, not already working that day, and (if
  // capped) safe on pay-period cap and the consecutive-day limit. Used
  // to backfill the slot a drag just vacated, not to assign the drag's
  // destination (that's still exactly what the manager dropped).
  //
  // Three tiers, each a step more disruptive than the last:
  //  1. Someone completely free that day — nobody else is touched.
  //  2. Someone who already holds this EXACT code within a few days
  //     either way, relocated here instead of calling in someone new —
  //     see findRelocatableHolder. The caller still has to flag (not
  //     fill) the fresh gap this opens on their old day, so a chain of
  //     "who's short" stays visible instead of a brand-new PRN quietly
  //     appearing to paper over it.
  //  3. A free PRN, same last resort as before.
  // `protectedDayIndices` keeps tier 2 from reaching into a day this
  // same swap is already editing (dayIdxA/dayIdxB) — that day's clone is
  // still held by a local variable elsewhere in applyManualSwap, and
  // relocating out of it here would silently re-clone over those edits.
  const findReplacementForSlot = (workingDays, dayIdx, code, excludeEmpId, protectedDayIndices = []) => {
    const day = workingDays[dayIdx];
    const used = new Set(Object.values(day.assignment).map((a) => a.empId));
    const perm = permanent.find((p) => p.id !== excludeEmpId && !used.has(p.id) && p.allowedShifts.includes(code)
      && ptoStatus[key(p.id, dayIdx)] !== "PTO1" && ptoStatus[key(p.id, dayIdx)] !== "PTO2"
      && respectsFixedDayRestriction(p, [day.dow])
      && !wouldExceedShiftCap(p, workedDayIndicesFromSchedule(workingDays, p.id), [dayIdx], capForBlock(p))
      && !(consecutiveHardLimit && wouldExceedConsecutiveDays(workedDayIndicesFromSchedule(workingDays, p.id), [dayIdx], maxConsecutiveDays)));
    if (perm) return { empId: perm.id, type: "permanent" };
    const relocated = findRelocatableHolder(workingDays, dayIdx, code, excludeEmpId, used, protectedDayIndices);
    if (relocated) return relocated;
    const ex = extra.find((x) => x.id !== excludeEmpId && !used.has(x.id) && x.allowedShifts.includes(code) && extraAvailable[key(x.id, dayIdx)]);
    return ex ? { empId: ex.id, type: "extra" } : null;
  };

  // Tier 2 of findReplacementForSlot: searches outward (closest day
  // first, alternating before/after) up to RELOCATE_WINDOW days either
  // side of `dayIdx` for someone — permanent checked before PRN — who
  // already has `code` there and could safely be moved to `dayIdx`
  // instead. Only ever bumps an OVERFLOW (E0) filler already sitting on
  // `dayIdx`, never a second real shift, and never pulls from a fixed,
  // override, or protected day. Returns `relocatedFromDayIdx` so the
  // caller can clear that day and flag the gap it just created.
  const RELOCATE_WINDOW = 3;
  const findRelocatableHolder = (workingDays, dayIdx, code, excludeEmpId, usedOnTargetDay, protectedDayIndices) => {
    const targetDay = workingDays[dayIdx];
    const searchOrder = [];
    for (let offset = 1; offset <= RELOCATE_WINDOW; offset++) {
      if (dayIdx - offset >= 0) searchOrder.push(dayIdx - offset);
      if (dayIdx + offset < workingDays.length) searchOrder.push(dayIdx + offset);
    }
    for (const [list, type] of [[permanent, "permanent"], [extra, "extra"]]) {
      for (const otherIdx of searchOrder) {
        if (protectedDayIndices.includes(otherIdx)) continue;
        const otherDay = workingDays[otherIdx];
        const entry = Object.entries(otherDay.assignment).find(([c, info]) => c === code && info.type === type);
        if (!entry) continue;
        const [, info] = entry;
        if (info.empId === excludeEmpId || info.fixed || info.override) continue;
        const candidate = list.find((p) => p.id === info.empId);
        if (!candidate) continue;
        const bumpedOverflowKey = Object.entries(targetDay.assignment).find(([c, i]) => isOverflowKey(c) && i.empId === candidate.id)?.[0];
        if (usedOnTargetDay.has(candidate.id) && !bumpedOverflowKey) continue;
        if (ptoStatus[key(candidate.id, dayIdx)] === "PTO1" || ptoStatus[key(candidate.id, dayIdx)] === "PTO2") continue;
        if (!respectsFixedDayRestriction(candidate, [targetDay.dow])) continue;
        if (type === "permanent") {
          // Excludes both the day they're being pulled FROM (that day's
          // about to stop counting for them) and `dayIdx` itself — if
          // they're already on `dayIdx` via an overflow filler (the only
          // way usedOnTargetDay lets a candidate through at all), it's
          // already in workedDayIndicesFromSchedule and would otherwise
          // get double-counted once more as the "proposed" day below.
          const existingWorked = workedDayIndicesFromSchedule(workingDays, candidate.id).filter((idx) => idx !== otherIdx && idx !== dayIdx);
          if (wouldExceedShiftCap(candidate, existingWorked, [dayIdx], capForBlock(candidate))) continue;
          if (consecutiveHardLimit && wouldExceedConsecutiveDays(existingWorked, [dayIdx], maxConsecutiveDays)) continue;
        } else if (!extraAvailable[key(candidate.id, dayIdx)]) continue;
        return { empId: candidate.id, type, relocatedFromDayIdx: otherIdx, bumpedOverflowKey };
      }
    }
    return null;
  };

  // Save slots: a deliberate snapshot of whatever's currently on screen
  // (generated or hand-edited) into one of two named slots, to compare
  // against or fall back to later without it getting silently overwritten
  // by the next generate/edit the way `schedule` itself is. Overwriting an
  // already-occupied slot asks first, same as every other destructive
  // action in this app.
  const saveToSlot = (slot) => {
    if (!schedule) return;
    if (scheduleSlots[slot] && !window.confirm(`${slotLabel(slot)} already has a saved schedule from ${new Date(scheduleSlots[slot].savedAt).toLocaleString()}. Overwrite it with the current schedule?`)) return;
    const savedAt = new Date().toISOString();
    const name = scheduleSlots[slot]?.name || null;
    setScheduleSlots((prev) => ({ ...prev, [slot]: { snapshot: schedule, savedAt, name } }));
    saveScheduleSlot(slot, schedule, viewingOwnerId, name).catch(reportSyncError);
  };
  // Renaming only ever touches the `name` column — the saved snapshot and
  // its timestamp are left exactly as they were.
  const renameSlot = (slot) => {
    const current = scheduleSlots[slot]?.name || "";
    const input = window.prompt(`Name for Slot ${slot} (leave blank to use the default "File name ${slot}"):`, current);
    if (input === null) return;
    const name = input.trim() || null;
    setScheduleSlots((prev) => ({ ...prev, [slot]: { ...prev[slot], name } }));
    renameScheduleSlot(slot, name, viewingOwnerId).catch(reportSyncError);
  };
  const slotLabel = (slot) => scheduleSlots[slot]?.name || `File name ${slot}`;
  // Loading a slot replaces the active schedule outright — same as
  // Regenerate, any unsaved manual edits on screen are gone. It also
  // becomes the new auto-saved "current" schedule, so it's what's there
  // on the next reload; the slot itself is untouched, so it's still
  // there to load again later.
  const loadFromSlot = (slot) => {
    const saved = scheduleSlots[slot];
    if (!saved) return;
    if (schedule) setUndoStack((s) => [...s.slice(-(UNDO_LIMIT - 1)), schedule]);
    applyScheduleSnapshot(saved.snapshot);
    saveScheduleSnapshot(saved.snapshot, viewingOwnerId).catch(reportSyncError);
    setTab("schedule");
  };

  // "Scan for missing shifts" — a deliberate, on-demand check for
  // permanent staff who are under their own guaranteed shift count on
  // the CURRENT grid, however it got that way (generate(), a drag, a
  // relocation side-effect, several of each). Unlike the auto-rearrange
  // banner, this never cares HOW someone fell short — it just looks at
  // where things stand right now.
  //
  // Two passes: an employee's running total vs their scaled cap first
  // (shiftTallyFor, the same numbers the Shifts column shows) just to
  // decide who's worth a closer look; then each of THEIR pay periods
  // gets checked against its own guarantee (PTO-1 shrinks it, exactly
  // like applyMinimumShiftGuarantees does), since someone under overall
  // can still have hit every period they've reached so far — the
  // shortfall is still ahead of them, in a later period.
  //
  // For each period that's short, flags exactly one empty day for them —
  // the best of however many are open that period, scored by: whether a
  // real coverage hole they're trained for already sits there (most
  // actionable), how many lonely shifts/lonely days-off it leaves across
  // their whole schedule, and whether it cuts into an off-weekend worth
  // extending. Never auto-assigns anything — purely a flag for the
  // manager to act on by hand, same spirit as the phantom-coverage
  // marker. A fresh click always replaces the whole flagged set outright,
  // it never accumulates across clicks.
  const scanForMissingShifts = () => {
    if (!schedule) return;
    const cells = new Set();
    const report = [];
    permanent.forEach((e) => {
      if (!e.shiftCap) return;
      const tally = shiftTallyFor(e);
      if (tally.cap == null || tally.total >= tally.cap) return;
      const { windowDays, maxShifts } = e.shiftCap;
      const worked = workedDayIndicesFromSchedule(schedule.days, e.id);
      const workedSet = new Set(worked);
      const totalDays = schedule.days.length;
      const numBlocks = Math.ceil(totalDays / windowDays);
      for (let b = 0; b < numBlocks; b++) {
        const blockStart = b * windowDays;
        const blockEnd = Math.min(blockStart + windowDays, totalDays);
        const target = guaranteeTargetForBlock(ptoStatus, ptoSource, e.id, blockStart, blockEnd, maxShifts);
        const actualInBlock = worked.filter((idx) => idx >= blockStart && idx < blockEnd).length;
        if (actualInBlock >= target) continue;

        let best = null, bestScore = Infinity;
        for (let idx = blockStart; idx < blockEnd; idx++) {
          if (workedSet.has(idx)) continue;
          if (ptoStatus[key(e.id, idx)]) continue;
          const day = schedule.days[idx];
          if (!respectsFixedDayRestriction(e, [day.dow])) continue;
          if (consecutiveHardLimit && wouldExceedConsecutiveDays(worked, [idx], maxConsecutiveDays)) continue;

          const hypotheticalWorked = [...worked, idx];
          const hypotheticalWorkedSet = new Set(hypotheticalWorked);
          const freeIdx = schedule.days.filter((d) => !hypotheticalWorkedSet.has(d.idx) && !ptoStatus[key(e.id, d.idx)]).map((d) => d.idx);
          const hasMatchingHole = day.holes.some((hc) => e.allowedShifts.includes(hc));
          const score = (hasMatchingHole ? 0 : 1)
            + countLonelyShifts(hypotheticalWorked, totalDays)
            + countLonelyDaysOff(hypotheticalWorked, freeIdx)
            + (breaksOffWeekend(e, day) ? 1 : 0);
          if (score < bestScore) { bestScore = score; best = idx; }
        }

        const periodLabel = `${schedule.days[blockStart].wd} ${schedule.days[blockStart].md} – ${schedule.days[blockEnd - 1].wd} ${schedule.days[blockEnd - 1].md}`;
        if (best == null) {
          report.push(`${e.name} is short ${target - actualInBlock} shift(s) for ${periodLabel}, but no safe open day was found — check training, fixed days, and the consecutive-day limit by hand.`);
          continue;
        }
        cells.add(key(e.id, best));
        const d = schedule.days[best];
        report.push(`${e.name} is short ${target - actualInBlock} shift(s) for ${periodLabel} — suggested day: ${d.wd} ${d.md}.`);
      }
    });
    setMissingShiftCells(cells);
    setMissingShiftReport(report);
  };

  // Shared tail for every manual edit (swap or fill): rebuild every report
  // from the edited day array and log it the same way generate() does.
  // One place, so a future third kind of manual edit gets this for free.
  const recomputeAndPersistSchedule = (prev, newDays) => {
    const updated = { ...prev, ...buildScheduleDerived(newDays), costAfter: costOf(newDays, newDays.length) };
    saveScheduleSnapshot(updated, viewingOwnerId).catch(reportSyncError);
    return updated;
  };

  // Swaps what two existing cells show — each stays tied to its own
  // (employee, day); only the shift code (or lack of one) each displays
  // trades places. See buildScheduleDerived for why every report updates
  // automatically from this alone.
  const applyManualSwap = (empA, dayIdxA, empB, dayIdxB) => {
    setSchedule((prev) => {
      if (!prev) return prev;
      // Clone into a working array first, then pull dayA/dayB FROM that
      // array (not from prev.days) — when dayIdxA === dayIdxB (swapping
      // two people's shifts on the same day), dayA and dayB must end up
      // as the exact same cloned object, or one clone's edits silently
      // overwrite the other's.
      const workingDays = [...prev.days];
      const cloneDay = (idx) => { workingDays[idx] = { ...workingDays[idx], assignment: { ...workingDays[idx].assignment } }; return workingDays[idx]; };
      const dayA = cloneDay(dayIdxA);
      const dayB = dayIdxB === dayIdxA ? dayA : cloneDay(dayIdxB);

      const entryA = Object.entries(dayA.assignment).find(([, info]) => info.empId === empA.id);
      const entryB = Object.entries(dayB.assignment).find(([, info]) => info.empId === empB.id);
      const [codeA] = entryA || [null];
      const [codeB] = entryB || [null];
      if (!codeA && !codeB) return prev;
      setUndoStack((s) => [...s.slice(-(UNDO_LIMIT - 1)), prev]);

      if (codeA) delete dayA.assignment[codeA];
      if (codeB) delete dayB.assignment[codeB];
      if (codeB) dayA.assignment[codeB] = { empId: empA.id, type: empA.type, override: false, fixed: false, manual: true };
      if (codeA) dayB.assignment[codeA] = { empId: empB.id, type: empB.type, override: false, fixed: false, manual: true };

      // Dragging onto someone who wasn't working that day moves a shift
      // rather than trading one, so the source slot is now empty. Fill
      // it right away with whoever can safely take it, so the grid
      // never has to show a fresh hole just because one shift moved —
      // left as a real hole (for the "Fill a coverage gap" card) only
      // when nobody safe is free.
      //
      // Tier 2 of that search (see findReplacementForSlot) can RELOCATE
      // someone who already holds this code on a nearby day instead of
      // calling in someone new — that opens a fresh gap on the day
      // they're pulled FROM, which gets cleared and flagged here right
      // alongside the original one, same badge and warning pipeline.
      // Never auto-filled further: the manager resolves it by hand, so
      // the chain of "who's short" stays visible instead of silently
      // cascading.
      const relocationLosses = [];
      const applyReplacement = (targetDay, code, replacement) => {
        if (replacement.bumpedOverflowKey) delete targetDay.assignment[replacement.bumpedOverflowKey];
        targetDay.assignment[code] = { empId: replacement.empId, type: replacement.type, override: false, fixed: false, manual: true };
        if (replacement.relocatedFromDayIdx == null) return;
        const otherDay = cloneDay(replacement.relocatedFromDayIdx);
        delete otherDay.assignment[code];
        otherDay.holes = holesOnDay(otherDay);
        relocationLosses.push({ empId: replacement.empId, dayIdx: replacement.relocatedFromDayIdx, code });
      };
      if (dayIdxA !== dayIdxB) {
        if (codeA && !codeB) {
          const replacement = findReplacementForSlot(workingDays, dayIdxA, codeA, empA.id, [dayIdxA, dayIdxB]);
          if (replacement) applyReplacement(dayA, codeA, replacement);
        }
        if (codeB && !codeA) {
          const replacement = findReplacementForSlot(workingDays, dayIdxB, codeB, empB.id, [dayIdxA, dayIdxB]);
          if (replacement) applyReplacement(dayB, codeB, replacement);
        }
      }
      dayA.holes = holesOnDay(dayA);
      dayB.holes = holesOnDay(dayB);

      // Only a genuine loss when a DIFFERENT employee ends up with the
      // day and nothing comes back — dragging your OWN shift to a new
      // day (empA === empB) isn't a loss, just a relocation; the old
      // day either gets backfilled or shows as a real hole, both
      // already visible on their own. A relocation loss (above) always
      // flags, regardless: it's always a different, third employee.
      setKickedOutCells((prev) => {
        const next = new Set(prev);
        if (empA.id !== empB.id) {
          if (codeA && !codeB) next.add(key(empA.id, dayIdxA));
          if (codeB && !codeA) next.add(key(empB.id, dayIdxB));
        }
        relocationLosses.forEach(({ empId, dayIdx }) => next.add(key(empId, dayIdx)));
        return next;
      });

      const relocationWarnings = relocationLosses.map(({ empId, dayIdx, code }) => {
        const who = [...permanent, ...extra].find((p) => p.id === empId);
        const d = days[dayIdx];
        return `${who?.name || "Someone"}'s ${shiftLabel(code)} shift on ${d.wd} ${d.md} was moved to cover the gap this opened up — that day needs covering now instead.`;
      });

      setManualEditWarnings([
        ...manualEditWarning(workingDays, empA, dayIdxA, codeB, codeA),
        ...manualEditWarning(workingDays, empB, dayIdxB, codeA, codeB),
        ...relocationWarnings,
      ]);
      return recomputeAndPersistSchedule(prev, workingDays);
    });
  };

  // Fills a coverage gap directly — no one to swap with, so this is a
  // pure addition rather than a trade. Same warning/report pipeline as a
  // swap; the only difference is there's nothing to remove on the other
  // side.
  const applyManualFill = (targetEmp, dayIdx, code) => {
    setSchedule((prev) => {
      if (!prev) return prev;
      setUndoStack((s) => [...s.slice(-(UNDO_LIMIT - 1)), prev]);
      const workingDays = [...prev.days];
      const day = { ...workingDays[dayIdx], assignment: { ...workingDays[dayIdx].assignment } };
      day.assignment[code] = { empId: targetEmp.id, type: targetEmp.type, override: false, fixed: false, manual: true };
      day.holes = holesOnDay(day);
      workingDays[dayIdx] = day;

      setManualEditWarnings(manualEditWarning(workingDays, targetEmp, dayIdx, code));
      return recomputeAndPersistSchedule(prev, workingDays);
    });
  };

  // Deliberately adds a cushion body on E0, independent of whether that
  // day has an actual coverage gap — E0 is never a hole (see gapsList),
  // so there's nothing in the normal fill pipeline to hang this off of.
  // Always picks a fresh numbered key (nextOverflowKey) rather than the
  // bare "E0" literal, so it never collides with — or overwrites —
  // anyone already padded up on E0 that same day.
  const applyOverflowFill = (targetEmp, dayIdx) => {
    setSchedule((prev) => {
      if (!prev) return prev;
      setUndoStack((s) => [...s.slice(-(UNDO_LIMIT - 1)), prev]);
      const workingDays = [...prev.days];
      const day = { ...workingDays[dayIdx], assignment: { ...workingDays[dayIdx].assignment } };
      const code = nextOverflowKey(day.assignment);
      day.assignment[code] = { empId: targetEmp.id, type: targetEmp.type, override: false, fixed: false, manual: true };
      day.holes = holesOnDay(day);
      workingDays[dayIdx] = day;

      setManualEditWarnings(manualEditWarning(workingDays, targetEmp, dayIdx, code));
      return recomputeAndPersistSchedule(prev, workingDays);
    });
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

  const optimizationTips = useMemo(() => (schedule ? buildOptimizationTips({
    schedule, feasibility, employees, ptoStatus, shiftLabel,
    settings: schedule.settingsUsed,
    continuityCodes: ALL_SHIFT_CODES.filter(isContinuityCode),
  }) : []), [schedule, feasibility, employees, ptoStatus, shiftDefByCode]);

  const cellFor = (employee, day) => {
    const entry = Object.entries(day.assignment).find(([, info]) => info.empId === employee.id);
    if (entry) return { code: overflowBaseCode(entry[0]), override: entry[1].override, manual: entry[1].manual, phantom: entry[1].phantom, forcedHoliday: entry[1].forcedHoliday, pinned: entry[1].pinned };
    const k = key(employee.id, day.idx);
    const st = ptoStatus[k];
    // A weekend blocked off by their rotation cycle isn't the same thing
    // as approved time off — same hard-block effect on the matcher, but
    // a manager reading the grid needs to tell "on leave" from "just not
    // their weekend" at a glance, so it gets its own code here.
    if (st === "PTO1") return { code: ptoSource[k] === "weekend_rotation" ? "WKND" : "PTO-1" };
    if (st === "PTO2") return { code: "PTO-2" };
    if (employee.type === "extra") return { code: "" };
    return { code: "OFF" };
  };

  // Live "how loaded is this person right now" readout for the tally
  // column — recomputed from the CURRENT schedule.days, so it updates the
  // moment a drag-and-drop move or gap fill changes anything. For a
  // capped employee this is their actual peak shift count in any window
  // their own cap uses, compared to that cap; uncapped just shows their
  // running total. PTO-1 needs no special handling here — worked day
  // indices only ever include a day someone was actually assigned, which
  // a PTO-1 day never is.
  // `peak` (worst window anywhere in the whole schedule) is what actually
  // has to stay correct, so it's what drives the cap comparison and the
  // red flag — total alone can't be safely compared to a per-window cap
  // (a multi-period schedule's total is naturally a multiple of it, e.g.
  // 38 total vs a cap of 10 looks alarming but is normal over 8 weeks).
  // `total` is shown alongside it purely so the number visibly moves on
  // every drag — peak only drops once ALL windows touching the removed
  // day fall below the old high-water mark, so it can look "stuck" after
  // a single edit even though the data changed correctly.
  const shiftTallyFor = (employee) => {
    const worked = workedDayIndicesFromSchedule(schedule.days, employee.id);
    const total = worked.length;
    if (!employee.shiftCap) return { total, cap: null, peak: total, over: false };
    const { windowDays, maxShifts } = employee.shiftCap;
    const peak = maxShiftsInAnyPayPeriod(worked, windowDays);
    // What's actually reachable isn't a flat cap × periods: approved
    // PTO-1 counts toward the guarantee itself (a block with 3 days off
    // only needs 7 real shifts against a 10-shift target, not 10), so
    // each block's own target shrinks by however many PTO-1 days (not
    // counting a weekend-rotation day off) fall inside it; a day auto-
    // blocked by weekend rotation still removes a candidate day without
    // lowering the target, the same as the generator treats it. Run the
    // same fill the generator uses, from a clean slate, to get this
    // employee's true achievable total so the denominator never shows
    // an unreachable — or, with PTO ignored, an inflated — number.
    const candidateIndices = schedule.days
      .filter((d) => ptoStatus[key(employee.id, d.idx)] !== "PTO1")
      .map((d) => d.idx);
    const targetForBlockIndex = (blockIndex) => guaranteeTargetForBlock(
      ptoStatus, ptoSource, employee.id, blockIndex * windowDays, Math.min(blockIndex * windowDays + windowDays, schedule.days.length), maxShifts
    );
    const scaledCap = pickOverflowDays([], candidateIndices, schedule.days.length, windowDays, targetForBlockIndex).length;
    return { total, cap: scaledCap, peak, over: peak > maxShifts };
  };

  // Every unfilled shift, flattened to one row per (day, code) — feeds
  // the "Fill a coverage gap" card. Empty once nothing's left to fill.
  const gapsList = schedule ? schedule.days.flatMap((d) => d.holes.map((code) => ({ day: d, code }))) : [];
  // Days with spare (E0) coverage — someone's already an extra body
  // beyond what the day actually needs, so it's worth a look before
  // approving a PTO request. A genuine overflow pick is a comfortable
  // cushion; a phantom that fell back to E0 is also an extra body that
  // day, but a forced one (the algorithm had to override the
  // consecutive-day limit for them elsewhere in their own schedule), so
  // the two are kept separate rather than blended into one reassuring
  // number. A phantom that instead took over someone's real shift (not
  // a fresh E0) isn't a net-new body at all, so it's left out entirely.
  const overflowDaysList = schedule ? schedule.days
    .map((d) => {
      const nameOf = (empId) => [...permanent, ...extra].find((p) => p.id === empId)?.name || "?";
      const overflowEntries = Object.entries(d.assignment).filter(([code]) => isOverflowKey(code));
      return {
        day: d,
        names: overflowEntries.filter(([, info]) => !info.phantom).map(([, info]) => nameOf(info.empId)),
        phantomNames: overflowEntries.filter(([, info]) => info.phantom).map(([, info]) => nameOf(info.empId)),
      };
    })
    .filter((x) => x.names.length > 0 || x.phantomNames.length > 0) : [];
  // Who could plausibly take a given gap: not already working that day
  // (hard — a person can't be in two places at once) and not on
  // approved PTO-1 leave / marked unavailable that day (hard, same rule
  // drag-and-drop uses). Trained-or-not is left to the dropdown's label
  // and the warning banner, not filtered out, so a manager can still
  // deliberately use someone not formally trained if that's their call.
  const eligibleCandidatesFor = (day, code) => {
    const alreadyWorking = new Set(Object.values(day.assignment).map((a) => a.empId));
    const permCandidates = permanent.filter((e) => !alreadyWorking.has(e.id) && ptoStatus[key(e.id, day.idx)] !== "PTO1");
    const prnCandidates = extra.filter((e) => !alreadyWorking.has(e.id) && extraAvailable[key(e.id, day.idx)]);
    return [...permCandidates, ...prnCandidates]
      .map((e) => ({ ...e, trained: e.allowedShifts.includes(code) }))
      .sort((a, b) => (b.trained - a.trained) || a.name.localeCompare(b.name));
  };

  // Candidates for the overflow-coverage tool: permanent staff only (by
  // design — this is a deliberate cushion-body tool, not the general
  // gap-fill one above, which already covers PRNs), same hard rules as
  // everywhere else (not already working that day, not on approved
  // PTO-1). No "trained" label — E0 is a placeholder body, not a shift
  // anyone is actually trained on, so that distinction doesn't apply.
  const overflowCandidatesFor = (dayIdx) => {
    const day = schedule.days[dayIdx];
    const alreadyWorking = new Set(Object.values(day.assignment).map((a) => a.empId));
    return permanent.filter((e) => !alreadyWorking.has(e.id) && ptoStatus[key(e.id, dayIdx)] !== "PTO1").sort((a, b) => a.name.localeCompare(b.name));
  };

  // Pay periods are fixed 14-day blocks anchored to the schedule's own
  // start, same window the cap/guarantee logic elsewhere uses. True for
  // the last day of every full block, and also for the schedule's very
  // last day when the final block is a short partial one — so a tally
  // column always gets inserted right after this day, never leaving a
  // (possibly partial) trailing period without its own total.
  const periodWindowDays = 14;
  const isPeriodEnd = (idx) => (idx + 1) % periodWindowDays === 0 || idx === schedule.days.length - 1;
  // Shifts actually worked (never PTO or a day off — those never create
  // an assignment entry in the first place, see workedDayIndicesFromSchedule)
  // within the pay period that ends on `idx`. `idx` can be a short final
  // block's last day, which Math.floor naturally resolves to that same
  // partial block's own start, not the previous full one.
  const periodTallyFor = (empId, idx) => {
    const blockStart = Math.floor(idx / periodWindowDays) * periodWindowDays;
    return workedDayIndicesFromSchedule(schedule.days, empId).filter((i) => i >= blockStart && i <= idx).length;
  };
  const periodTallyBorder = { borderLeft: "3px solid #1A2233" };
  const renderScheduleTable = (list, title) => {
    // A second header row labeling each Saturday/Sunday pair "Weekend
    // N" (1-based, numbered straight through the whole schedule, same
    // weekend index the rotation grouping elsewhere already uses) — a
    // quick reference point distinct from the pay-period lines, since a
    // 14-day period always spans exactly two of these.
    const weekendHeaderCells = [];
    for (let i = 0; i < schedule.days.length; i++) {
      const d = schedule.days[i];
      let lastIdx = d.idx;
      if (d.dow === 6 && schedule.days[i + 1]?.dow === 0) {
        const wIdx = weekendIndexFor(d.date, weekendEpoch);
        weekendHeaderCells.push(
          <th key={d.idx} colSpan={2} className="px-1 py-1 text-center text-[10px] font-semibold text-[#64748B] bg-[#F1F5F9] border-b border-[#E4E7EC]">
            Weekend {wIdx + 1}
          </th>
        );
        i++; // the Sunday is already covered by the colSpan above
        lastIdx = schedule.days[i].idx;
      } else {
        weekendHeaderCells.push(<th key={d.idx} className="border-b border-[#E4E7EC]" />);
      }
      if (isPeriodEnd(lastIdx)) {
        weekendHeaderCells.push(<th key={`pp-${lastIdx}`} className="border-b border-[#E4E7EC] bg-[#F1F5F9]" style={periodTallyBorder} />);
      }
    }
    return (
    <div className="bg-white rounded-lg border border-[#E4E7EC] overflow-x-auto mb-4">
      <div className="px-4 py-2 border-b border-[#E4E7EC] text-sm font-semibold">{title}</div>
      <table className="text-xs border-collapse">
        <thead>
          <tr>
            <th className="sticky left-0 bg-white z-10 min-w-[56px]" />
            <th className="sticky left-[56px] bg-white z-10 min-w-[150px]" />
            {weekendHeaderCells}
          </tr>
          <tr>
            <th className="sticky left-0 bg-white z-10 text-center px-1 py-2 border-b border-[#E4E7EC] min-w-[56px]" title="Running total for the whole schedule over their extended-hour cap, scaled up to the full schedule length. Approved PTO-1 counts toward the guarantee itself, so a pay period with time off needs fewer real shifts, not the same number crammed into what's left. Moves up or down immediately with every drag or gap fill, so swapping two people always moves both numbers at once. Turns red if any single pay period actually goes over the cap — hover for the exact numbers.">Shifts</th>
            <th className="sticky left-[56px] bg-white z-10 text-left px-3 py-2 border-b border-[#E4E7EC] min-w-[150px]">Employee</th>
            {schedule.days.flatMap((d) => {
              const dayHeader = (
                <th key={d.idx} className={`px-1 py-2 border-b border-[#E4E7EC] font-normal text-center min-w-[36px] ${d.isWknd ? "bg-[#F1F5F9]" : ""}`}>
                  <div className="text-[#64748B]">{d.wd[0]}</div><div className="text-[10px]">{d.md}</div>
                  {holidays.has(d.iso) && <div className="text-[9px] text-[#DC2626]">HOL</div>}
                </th>
              );
              if (!isPeriodEnd(d.idx)) return [dayHeader];
              return [dayHeader, (
                <th key={`pp-${d.idx}`} className="px-1 py-2 border-b border-[#E4E7EC] font-normal text-center min-w-[28px] bg-[#F1F5F9]" style={periodTallyBorder} title="Pay period total — shifts actually worked this period, not counting PTO or days off. Updates live as you drag or fill gaps.">
                  Σ
                </th>
              )];
            })}
          </tr>
        </thead>
        <tbody>
          {list.map((emp) => {
            const tally = shiftTallyFor(emp);
            return (
            <tr key={emp.id}>
              <td
                className="sticky left-0 bg-white z-10 px-1 py-1 border-b border-[#F1F5F9] text-center font-semibold"
                style={{ color: tally.over ? "#DC2626" : "#64748B" }}
                title={tally.cap != null
                  ? `Running total this schedule: ${tally.total} of ${tally.cap}. Heaviest ${emp.shiftCap.windowDays}-day pay period: ${tally.peak} of ${emp.shiftCap.maxShifts}.`
                  : `${tally.total} shifts total — no cap set`}
              >
                {tally.cap != null ? `${tally.total}/${tally.cap}` : tally.total}
              </td>
              <td className="sticky left-[56px] bg-white z-10 px-3 py-1 border-b border-[#F1F5F9] font-medium">
                {emp.name}{emp.type === "extra" && <span className="ml-1 text-[9px] text-[#64748B]">PRN</span>}
              </td>
              {schedule.days.flatMap((d) => {
                const { code, override, manual, phantom, forcedHoliday, pinned } = cellFor(emp, d);
                const isShift = ALL_SHIFT_CODES.includes(code);
                const displayText = code === "OFF" ? "" : isShift ? shiftLabel(code) : code;
                const kickedOut = code === "OFF" && kickedOutCells.has(key(emp.id, d.idx));
                const missingFlag = code === "OFF" && !kickedOut && missingShiftCells.has(key(emp.id, d.idx));
                const bg = isShift ? getShiftColor(code) : (code === "PTO-1" || code === "WKND") ? "#DC2626" : code === "PTO-2" ? "#F59E0B" : code === "OFF" ? "#E4E7EC" : "transparent";
                const fg = isShift || code === "PTO-1" || code === "WKND" || code === "PTO-2" ? "#fff" : "#64748B";
                const draggable = canDragCell(code);
                const droppable = canDropOnCell(emp, d);
                const dayCell = (
                  <td key={d.idx} className="border-b border-[#F1F5F9] p-0.5 text-center">
                    <div
                      className={phantom ? "relative w-9 h-6 rounded-sm flex items-center justify-center font-mono font-semibold animate-pulse" : "relative w-9 h-6 rounded-sm flex items-center justify-center font-mono font-semibold"}
                      style={{
                        background: bg, color: fg, fontSize: gridCellFontSize(displayText),
                        border: phantom ? "3px dashed #DC2626" : override ? "2px dashed #F59E0B" : pinned ? "3px solid #2563EB" : forcedHoliday ? "3px dashed #2563EB" : code === "WKND" ? "3px dashed #7C3AED" : (code === "PTO-1" || code === "PTO-2") ? "3px solid #000" : isContinuityCode(code) ? "2px solid #1A2233" : kickedOut ? "2px dashed #F59E0B" : missingFlag ? "2px dotted #F59E0B" : "none",
                        cursor: draggable ? "grab" : droppable ? "copy" : "default",
                      }}
                      title={phantom ? `Needs manual coverage — ${emp.name} is short their guaranteed shift count this pay period, but every safe day would break the ${maxConsecutiveDays}-day consecutive-day limit (often because a weekend-paired or continuity day sits right at the pay-period boundary). Counted toward their total; assign it by hand or relax the limit.` : pinned ? "Manually pinned — you chose this exact shift for this day, and the rest of the schedule was built around it." : forcedHoliday ? "Forced holiday work — scheduled here to cover sparse holiday staffing even though it's normally their day off." : kickedOut ? `${emp.name} had a real shift here before it was handed to someone else — a drag, or the generator's own rearrangement — with nothing given back. They may now be short; assign them something else if they still need to hit their target.` : missingFlag ? `"Scan for missing shifts" suggests this day for ${emp.name} — they're short their pay-period minimum, and this looked like the safest open day to cover it.` : code === "WKND" ? "Off per weekend rotation — not approved leave" : manual ? "Manually moved" : isShift && displayText !== code ? code : undefined}
                      draggable={draggable}
                      onDragStart={draggable ? (e) => { e.dataTransfer.setData("application/json", JSON.stringify({ empId: emp.id, dayIdx: d.idx })); e.dataTransfer.effectAllowed = "move"; } : undefined}
                      onDragOver={droppable ? (e) => e.preventDefault() : undefined}
                      onDrop={droppable ? (e) => {
                        e.preventDefault();
                        const raw = e.dataTransfer.getData("application/json");
                        if (!raw) return;
                        const { empId: sourceEmpId, dayIdx: sourceDayIdx } = JSON.parse(raw);
                        if (sourceEmpId === emp.id && sourceDayIdx === d.idx) return;
                        const sourceEmp = [...permanent, ...extra].find((x) => x.id === sourceEmpId);
                        if (sourceEmp) applyManualSwap(sourceEmp, sourceDayIdx, emp, d.idx);
                      } : undefined}
                    >
                      {displayText}{override ? "*" : ""}
                      {manual && <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-[#0D9488] border border-white" />}
                      {phantom && <span className="absolute -top-1.5 -right-1.5 w-3 h-3 rounded-full bg-[#DC2626] border border-white text-white text-[8px] leading-3 font-bold">!</span>}
                      {forcedHoliday && !phantom && <span className="absolute -top-1.5 -right-1.5 w-3 h-3 rounded-full bg-[#2563EB] border border-white text-white text-[7px] leading-3 font-bold">H</span>}
                      {pinned && !phantom && !forcedHoliday && <span className="absolute -top-1.5 -right-1.5 w-3 h-3 rounded-full bg-[#2563EB] border border-white text-white text-[7px] leading-3 font-bold">P</span>}
                      {kickedOut && <span className="absolute -top-1.5 -right-1.5 w-3 h-3 rounded-full bg-[#F59E0B] border border-white text-white text-[8px] leading-3 font-bold">−</span>}
                      {missingFlag && <span className="absolute -top-1.5 -right-1.5 w-3 h-3 rounded-full bg-[#F59E0B] border border-white text-white text-[8px] leading-3 font-bold">+</span>}
                    </div>
                  </td>
                );
                if (!isPeriodEnd(d.idx)) return [dayCell];
                const periodTotal = periodTallyFor(emp.id, d.idx);
                return [dayCell, (
                  <td key={`pp-${d.idx}`} className="border-b border-[#F1F5F9] p-0.5 text-center bg-[#F8FAFC] font-semibold text-[#1A2233]" style={periodTallyBorder} title={`${emp.name}: ${periodTotal} shift(s) actually worked this pay period — not counting PTO or days off. Live — updates with every drag or gap fill.`}>
                    {periodTotal}
                  </td>
                )];
              })}
            </tr>
            );
          })}
          <tr>
            <td colSpan={2} className="sticky left-0 bg-white z-10 px-3 py-1 font-semibold text-[#DC2626]">⚠ Coverage gaps</td>
            {schedule.days.flatMap((d) => {
              const gapCell = (
                <td key={d.idx} className="text-center p-0.5">
                  {d.holes.length > 0 ? (
                    <div className="w-9 h-6 rounded-sm flex items-center justify-center font-bold text-[9px] text-white animate-pulse" style={{ background: "#DC2626", boxShadow: "0 0 0 2px #DC2626" }} title={`Unfilled: ${d.holes.map(shiftLabel).join(", ")}`}>HOLE</div>
                  ) : null}
                </td>
              );
              if (!isPeriodEnd(d.idx)) return [gapCell];
              return [gapCell, <td key={`pp-${d.idx}`} className="text-center p-0.5" style={periodTallyBorder} />];
            })}
          </tr>
        </tbody>
      </table>
    </div>
    );
  };

  // One shared shape for every alert box at the top of the Schedule tab:
  // tone picks the color (critical = red, a real rule violation you may
  // need to act on; advisory = amber, worth knowing but not blocking;
  // success = green, an all-clear). `dismissKey`, when given, both adds
  // the Dismiss button and keys the dismissal to this alert's own exact
  // content — see dismissedAlerts above for why that's content, not a
  // boolean per type. Banners with their own existing dismiss wiring
  // (manualEditWarnings, missingShiftReport) don't need a dismissKey —
  // they already clear themselves the same way, just via their own
  // dedicated state instead of the shared Set.
  const dismissAlert = (keyStr) => setDismissedAlerts((prev) => new Set(prev).add(keyStr));
  const ALERT_TONE_CLASSES = {
    critical: "bg-[#FEE2E2] border-2 border-[#DC2626] text-[#991B1B] font-semibold",
    advisory: "bg-[#FEF3C7] border border-[#FDE68A] text-[#92400E]",
    success: "bg-[#ECFDF5] border border-[#A7F3D0] text-[#065F46]",
  };
  const AlertBox = ({ tone, dismissKey, onDismiss, children }) => {
    if (dismissKey && dismissedAlerts.has(dismissKey)) return null;
    return (
      <div className={`${ALERT_TONE_CLASSES[tone]} text-sm rounded px-3 py-2 flex items-start justify-between gap-3`}>
        <div className="flex-1">{children}</div>
        {(dismissKey || onDismiss) && (
          <button onClick={() => (onDismiss ? onDismiss() : dismissAlert(dismissKey))} className="text-xs underline whitespace-nowrap">Dismiss</button>
        )}
      </div>
    );
  };
  // Turns a joined-sentence violation list into a scannable bulleted
  // list instead — one line per violation, no semicolon-chain to parse.
  const AlertList = ({ items }) => (
    <ul className="list-disc list-inside mt-1 space-y-0.5">
      {items.map((item, i) => <li key={i}>{item}</li>)}
    </ul>
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
          {["instructions", "setup", "permanent", "extra", "schedule", "fairness", "optimization", ...(profile.role === "admin" ? ["import"] : [])].map((t) => (
            <button key={t} onClick={() => (t === "instructions" || t === "setup" || t === "permanent" || t === "extra" || t === "import" || schedule) && setTab(t)}
              className={`px-3 py-2 text-sm font-medium capitalize border-b-2 transition-colors ${tab === t ? "border-[#0D9488] text-[#0D9488]" : "border-transparent text-[#64748B] hover:text-[#1A2233]"} ${(t === "schedule" || t === "fairness" || t === "optimization") && !schedule ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}>
              {{ instructions: "1. Instructions", setup: "2. Setup", permanent: "3. Permanent Staff", extra: "4. PRN Staff", schedule: "5. Schedule", fairness: "6. Fairness Report", optimization: "7. Optimization", import: "8. Import" }[t]}
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
              <div className="text-sm font-semibold mb-1">The 7 tabs, in order</div>
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
                  <li><b>Name</b> — what actually shows on the schedule grid (up to 4 characters).</li>
                  <li><b>Weekend/holiday?</b> — tick this if the shift runs on weekends and holidays, in addition to weekdays.</li>
                  <li><b>Weekend only?</b> — tick this if the shift should <i>never</i> run Monday–Friday, only Saturday, Sunday, and holidays. Ticking it counts as "Weekend/holiday?" automatically — no need to tick both.</li>
                  <li><b>Continuity?</b> — tick this if the same person must stay on this shift for several days in a row once assigned. The <b>Days</b> column sets that range — see the warning box in the screenshot for which ranges actually work.</li>
                  <li><b>Paused?</b> — takes a shift out of rotation temporarily without deleting its history (max 2 at once).</li>
                </ul>
                <img src="/instructions/manage-shifts.png" alt="Manage shifts table with Name, Weekend/holiday, Weekend only, Continuity, Days, and Paused columns" className="w-full rounded border border-[#E4E7EC]" />
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
                  <li><b>Weekend pairing:</b> on someone's on weekend, the app tries to put them on the exact same shift both Saturday and Sunday — never working days on Saturday and evenings on Sunday. This only applies to Permanent Staff; PRN/backup staff are exempt by design, since they're meant to fill gaps, not hold a weekend pattern. Turn it off entirely with "Pair Saturday/Sunday to the same person" on the Setup tab if you'd rather Saturday and Sunday be filled independently.</li>
                  <li><b>Extend off-weekends:</b> tick "Extend off-weekends into longer weekends" on the Setup tab and the app also tries to give rotated staff the Friday before and Monday after their OFF weekend, turning it into a 4-day break. It's a preference, not a guarantee — it won't leave a shift empty just to stretch someone's weekend, and it skips anyone whose Friday or Monday is one of their fixed days (nothing to be done about those anyway).</li>
                </ul>
                <img src="/instructions/employee-row.png" alt="One employee row showing fixed days, extended-hour cap, and weekend rotation" className="w-full rounded border border-[#E4E7EC] mb-2" />

                <h3 className="text-sm font-semibold mb-1">"Extended-hour schedule" — now a guarantee, not just a ceiling</h3>
                <p className="text-xs text-[#33405A] mb-1">This checkbox covers two real situations. Don't skip it just because someone doesn't work 10s or 12s:</p>
                <ul className="list-disc pl-9 text-xs text-[#33405A] space-y-1 mb-2">
                  <li><b>1. Compressed schedules.</b> Anyone working 10-hour or 12-hour shifts — they naturally need fewer shifts to hit full-time hours, so give them a number that reflects that (e.g. 6 shifts per 14 days).</li>
                  <li><b>2. Regular 8-hour staff too.</b> Recommended: cap them at no more than 10 shifts in any 14-day period — this is <b>not</b> the same as consecutive days. It's a running total (10 shifts spread across 14 days, worked in any pattern), separate from the Max Consecutive Days streak rule. Use both together: one guards against too many days total, the other against too many days in a row.</li>
                </ul>
                <p className="text-xs text-[#33405A] mb-1"><b>The number is now a real guarantee, not just a "don't go over" ceiling.</b> The app makes sure each extended-hour person actually reaches it every period — the only accepted reason to fall short is approved PTO-1. When someone needs topping up, the app looks for a real reason first: an empty shift they're trained for, or a shift a PRN person is covering that they could take instead — no sense paying for PRN backup on a day someone who needs more hours could just do the job. Only when neither exists does it fall back to the reserved overflow shift (<b>E0</b>), which can go to more than one person the same day, and nobody ever gets more of it than their own personal shortfall — so it never piles onto one person.</p>
                <p className="text-xs text-[#33405A] mb-2">E0 shows up automatically in Manage Shifts (rename it to whatever you call this, like "ON CALL" or "ADMIN") — it's marked "Overflow" and can't be removed, only paused. Pausing it turns the whole guarantee off; the app goes back to pure best-effort balancing.</p>

                <h3 className="text-sm font-semibold mb-1">Apply weekend rotation — the final step</h3>
                <p className="text-xs text-[#33405A] mb-2">Setting someone's rotation group only records the setting — it doesn't block anything yet. Click this button to actually write those off-weekends onto the schedule as hard blocks. Safe to click again any time you change a rotation or add staff — it never touches a day you've edited by hand.</p>
                <img src="/instructions/apply-rotation.png" alt="Apply weekend rotation button with its explanation banner" className="w-full rounded border border-[#E4E7EC] mb-2" />

                <h3 className="text-sm font-semibold mb-1">Bulk block a date range — faster than clicking day by day</h3>
                <p className="text-xs text-[#33405A] mb-2">Above the employee list: set a start/end date, pick <b>PTO (hard)</b>, <b>DNS (soft)</b>, or <b>Force holiday (hard)</b>, then click "Block" on that employee's row to fill their whole range at once. "Clear" (same row) removes whichever kind over that range. This is just a shortcut for setting the grid below — same statuses, same rules.</p>
                <p className="text-xs text-[#33405A] mb-2"><b>Force holiday (hard)</b> is the opposite of PTO — it guarantees that employee a real shift on those dates even if it's normally their day off, for sparse holiday coverage. It won't override approved PTO-1 (you'll get a warning if the dates overlap), and a capped employee's pay period is automatically rebalanced so the forced day never pushes them over their max.</p>

                <h3 className="text-sm font-semibold mb-1">The PTO grid — for everything rotation doesn't cover</h3>
                <p className="text-xs text-[#33405A] mb-1">Below the button is a full calendar grid, one row per employee. Click any cell to cycle it through five states — use this for vacation, call-offs, a one-off mandatory holiday, a hand-written shift commitment, or any one-off day that weekend rotation wouldn't know about:</p>
                <ul className="list-disc pl-9 text-xs text-[#33405A] space-y-1 mb-2">
                  <li><b>Available</b> (blank) → <b>PTO-1, hard block</b> (red) → <b>PTO-2, soft/do-not-schedule</b> (amber) → <b>forced holiday work</b> (blue dot) → <b>a pinned exact shift</b> (opens a code picker) → back to available.</li>
                  <li><b>PTO-1</b> is absolute — honored no matter what, even if it creates a coverage gap.</li>
                  <li><b>PTO-2</b> is a preference — honored unless the schedule genuinely can't be covered without that person.</li>
                  <li><b>Forced holiday work</b> is the opposite of PTO — guarantees a real shift that day even if it's normally their day off, but the generator picks which trained, active code.</li>
                  <li><b>A pinned shift</b> is the most specific commitment of all: you pick the exact code yourself (e.g. "Reyna works E3 on 12/25 — already promised"), and the generator locks it in and builds everyone else's schedule around it. It won't override approved PTO-1, won't bump someone already holding that exact code that day, and won't push the employee over their shift cap — any of those gets flagged after you generate instead of silently happening. A pin for a code they aren't trained on is still honored (it's your explicit choice) but flagged too, in case that was a slip.</li>
                  <li>Each of the five states is exclusive, so moving a cell into one clears whichever of the others might already be set there.</li>
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
                  <li>Add on-call/as-needed people here. Each one gets a purple "PRN" badge and a light purple card so they're never mixed up with Permanent Staff at a glance.</li>
                  <li>The app only calls on them when your permanent staff genuinely can't cover a shift — never before.</li>
                  <li>Name and "Trained on" shifts are editable right on their row, same as Permanent Staff — click the name box or a shift button any time.</li>
                  <li><b>Extended-hour schedule</b> works the same as Permanent Staff, but defaults to <b>5 shifts per 14 days</b> instead of the permanent default — PRN work is meant to be occasional, so adjust both numbers if your rules differ.</li>
                  <li><b>Available days</b> — tick the weekdays this person generally works (e.g. just weekends), then hit "Apply to grid below." That fills in every matching day on the availability grid for you, instead of clicking each one by hand. It only ever <i>adds</i> days — if you've manually removed a day down in the grid, applying again won't bring it back; you'd need to click that day a second time to re-add it.</li>
                  <li><b>PTO start/end + Block / Clear</b> — for approved PTO only. Set the dates, then click "Block" on their row below — removes them completely for that span, no exceptions, no soft DNS option like permanent staff's PTO-2. "Clear" (same row) restores their normal pattern.</li>
                  <li>Grown into a regular team member? Use "Convert to permanent" to move them over without re-entering anything.</li>
                </ul>
                <img src="/instructions/prn-staff.png" alt="PRN Staff tab: editable name, extended-hour cap defaulting to 5 per 14 days, available-days-of-week pattern with Apply to grid button, editable trained-on shifts, and Block/Clear leave controls, all on a purple-bordered PRN card" className="w-full rounded border border-[#E4E7EC]" />
              </div>

              <div className="border-t border-[#F1F5F9] pt-3 mt-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-6 h-6 rounded-full bg-[#E6F6F4] text-[#0B6B62] text-xs font-bold flex items-center justify-center">5</span>
                  <h3 className="text-sm font-semibold">Schedule — your finished grid</h3>
                </div>
                <ul className="list-disc pl-9 text-xs text-[#33405A] space-y-1 mb-2">
                  <li>Every employee, every day, color-coded by shift.</li>
                  <li>A pulsing red <b>HOLE</b> badge means that shift couldn't be filled — hover it to see which shift and why.</li>
                  <li>An amber banner reading "couldn't be paired to the same person" means weekend pairing (see Permanent Staff above) couldn't find anyone free both Saturday and Sunday for that shift — it's a heads-up, not an error, and it tells you exactly which weekend to check.</li>
                  <li><b>Shifts column</b> (left of Employee) — shows their running total for the whole schedule over their extended-hour cap (scaled up to the schedule's full length), live. Swap two people's shifts and both numbers move at once — one up, one down. It turns red if any single pay period actually goes over the cap (hover the cell for the exact numbers) — that's your real "am I overloading anyone" checkpoint, separate from the total just ticking up or down.</li>
                  <li><b>Drag any shift cell onto another to swap them by hand.</b> If the cell you drop onto already had a shift, both people trade places. If it was empty, that person just gains the shift — the person you dragged FROM loses that day with nothing given back, and an amber dashed cell with a "−" badge marks exactly where, so you can see at a glance who might now be short and reassign them if they still need to hit their target. A small teal dot marks any cell you've moved. Fairness Report, Optimization, and Export CSV all update to match immediately. A continuity shift can't be dragged or dropped onto (it's a locked multi-day block), and neither can someone's approved PTO-1 leave day. If a swap puts someone on a shift they're not trained for or over a limit, you'll get an amber warning banner — it still goes through, since it's your call, but you'll know.</li>
                  <li>The same "−" badge (and an amber banner right after generating) also fires when <b>Generate/Regenerate itself</b> hands someone's shift to someone else with nothing given back — the optimizer does this internally while balancing fairness, same as a drag would, just without you clicking anything. Both causes look and read the same way, since the fix is the same either way: reassign them something else if they still need it.</li>
                  <li>Dragging someone <i>away</i> from a day they were covering, onto a day where the other person wasn't working, leaves their original day empty — that's not a bug. Nobody automatically backfills it, so it shows up honestly as a new Coverage gap instead of silently vanishing.</li>
                  <li><b>"Fill a coverage gap" card</b> — appears whenever there are HOLEs. Pick anyone — permanent or PRN — from the dropdown next to each empty shift to assign it directly, no dragging needed. Same rules as a drag swap: can't double-book someone or drop them on approved leave, but an untrained or over-limit pick still goes through with a warning.</li>
                  <li><b>"Add overflow (E0) coverage"</b> — always visible, right below the gap card, since E0 is never a HOLE and so never shows up there. Pick any day, then any permanent employee free that day, to pad them onto E0 as an extra cushion body — before a shortfall shows up, not after. Stacks alongside anyone already on E0 that day rather than replacing them.</li>
                  <li><b>Export CSV</b> turns it into a spreadsheet, including any manual swaps or gap-fills you've made. <b>Regenerate</b> reruns the optimizer from scratch if you want another pass — this discards any manual edits.</li>
                  <li><b>Regenerate-N</b> — reshuffles what's already on screen, it never decides who works which days. Nobody's total shift count for any pay period changes, because nobody's set of worked days changes — all it does is swap which <i>code</i> two people already working the same day are down for, whenever that spreads repeats out more evenly. The target: nobody gets the exact same code again until <b>N</b> of their own other worked days have passed — N is a dropdown next to the button, defaulting to however many real shift codes you have (a full cycle through the list before any repeat), with looser options if you'd rather allow repeats sooner. It runs 2,500 random trial swaps, same shape as the real optimizer's own local search, keeping each one only if it doesn't make the overall spacing worse. A swap only ever happens between two people each trained for the other's code. Weekends, holidays, pinned shifts, continuity blocks, phantom (needs-manual-coverage) slots, and any existing PRN coverage are never touched — those aren't ordinary already-working pairs eligible to swap. Since nobody's worked-day set ever changes, there's nothing here that can create a gap, go over a cap, or need a PTO/consecutive-day check at all. Whatever repeats can't be fixed this way (nobody eligible has training for the other's code) stay as they were — not flagged on the grid, but counted honestly: see "Early repeats" in the Fairness Report.</li>
                  <li><b>↶ Undo</b> — steps backward through the last 10 schedule-changing actions this session: either Regenerate button, a drag, a gap fill, an overflow assign, or loading a save slot. The number in the button is how many steps are available. It's session-only — closing the tab or reloading clears it, same as the other in-progress highlights on this tab — so it's a short-term "oops" safety net, not a permanent history. Save Slots are still the way to keep something indefinitely.</li>
                  <li><b>✓ Fairness check</b> — a pure re-scan, not a regenerate: it never changes a single assignment. Most of the Fairness Report already updates live on every edit, but Regenerate-N never sets the "fairness score before optimizer" banner at the top of this tab, so after using it that banner keeps showing a stale number from whenever Generate last actually ran. This button measures the grid exactly as it stands right now and replaces that banner with a fresh, accurate reading.</li>
                  <li><b>Save to File name 1 / File name 2</b> — keeps a copy of exactly what's on screen right now (including manual edits) in one of two slots, safe from the next Regenerate or edit. Click a saved slot to load it back as the active schedule — unsaved changes on screen are lost, same as Regenerate. Saving over an already-used slot asks you to confirm first. The ✏️ next to a saved slot lets you give it a custom name (e.g. "Before holidays") in place of the default "File name 1"/"File name 2" label — renaming never touches the saved schedule itself.</li>
                  <li><b>Scan for missing shifts</b> — a separate, on-demand check: scans every permanent employee's CURRENT grid (after any manual edits, whatever caused them) for anyone under their own pay-period minimum, PTO-1 counted toward it the same way the generator counts it, and flags the single best open day per shortfall with a dotted amber "+" cell — preferring a day that already has a real coverage gap they're trained for, and otherwise the one that creates the fewest lonely shifts or lonely days off and avoids cutting into an off-weekend. It only flags; it never assigns anything for you. Click it again any time — each click replaces the flagged cells with a fresh scan of what's on screen right now.</li>
                </ul>
                <img src="/instructions/schedule-grid.png" alt="Schedule grid with fairness score, a warning about unfillable shifts, the legend, and export/regenerate buttons" className="w-full rounded border border-[#E4E7EC] mb-2" />
                <img src="/instructions/weekend-pairing.png" alt="Schedule grid showing Saturday and Sunday columns with the same employee on the same shift code both days" className="w-full rounded border border-[#E4E7EC] mb-2" />
                <img src="/instructions/shift-tally.png" alt="Schedule grid with a new Shifts column to the left of Employee, showing each person's current shift count against their cap" className="w-full rounded border border-[#E4E7EC] mb-2" />
                <img src="/instructions/drag-swap.png" alt="Two employees' Monday shifts after being swapped by dragging, each marked with a small teal dot showing it was manually moved" className="w-full rounded border border-[#E4E7EC] mb-2" />
                <img src="/instructions/fill-gap.png" alt="Fill a coverage gap card listing each empty shift with a dropdown to assign a permanent or PRN employee directly" className="w-full rounded border border-[#E4E7EC]" />
              </div>

              <div className="border-t border-[#F1F5F9] pt-3 mt-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-6 h-6 rounded-full bg-[#E6F6F4] text-[#0B6B62] text-xs font-bold flex items-center justify-center">6</span>
                  <h3 className="text-sm font-semibold">Fairness Report — check the results</h3>
                </div>
                <p className="text-xs text-[#33405A] mb-2">Covered in detail further down this page.</p>
                <img src="/instructions/fairness-summary.png" alt="Overall balance summary banner at the top of the Fairness Report" className="w-full rounded border border-[#E4E7EC]" />
              </div>

              <div className="border-t border-[#F1F5F9] pt-3 mt-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-6 h-6 rounded-full bg-[#E6F6F4] text-[#0B6B62] text-xs font-bold flex items-center justify-center">7</span>
                  <h3 className="text-sm font-semibold">Optimization — what to fix next</h3>
                </div>
                <p className="text-xs text-[#33405A] mb-2">Plain-English fixes for the schedule you just generated: unfilled shifts, too many days in a row, scattered days off. Each card tells you which tab and field to change, and you can tick it off once done.</p>
              </div>
            </div>

            <div className="bg-white rounded-lg border border-[#E4E7EC] p-4">
              <div className="text-sm font-semibold mb-1">Special tools, explained simply</div>
              <p className="text-xs text-[#64748B] mb-3">These are the settings that solve the trickiest scheduling problems. Worth knowing well.</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                {[
                  ["Feasibility check", "Shows up on Setup, before you even generate. Tells you if you have enough people for the weeks ahead. Red numbers = you're short — add staff or backup coverage first."],
                  ["Weekend rotation", "Not everyone should work every weekend. Set how often someone's on duty (e.g. one weekend a month) — the app blocks their off weekends and protects their on weekend."],
                  ["Weekend pairing", "On someone's on weekend, Saturday and Sunday are kept as the same shift for the same person, best-effort. Permanent Staff only — PRN is exempt. Can't be paired? You'll get a clear amber warning on Schedule, not a silent mismatch. Switch it off on the Setup tab if you'd rather Saturday and Sunday be filled independently."],
                  ["Extend off-weekends", "Opt-in on the Setup tab. For rotated staff, tries to also give them the Friday before and Monday after their OFF weekend, for a longer break. Best-effort — never leaves a shift empty just to stretch someone's weekend, and skips any day that's already one of their fixed days."],
                  ["Fixed work days", "For people who always work the same days (like Mon–Fri). Their schedule locks to those days and never gets moved around."],
                  ["Max consecutive days", "Nobody wants a 10-day stretch with no day off. Set your limit. Soft = the app tries to avoid it. Hard = it's guaranteed, and backup staff cover the gap instead."],
                  ["Extended-hour cap", "A guaranteed shift count per rolling window (e.g. 10 per 14 days), not just a ceiling — a running total, not a streak. The app tops shortfalls up with the reserved E0 overflow shift; only approved PTO-1 is accepted as a reason to fall short."],
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
                  ["Lonely days off", "Single days off with work on both sides (work, off, work). Fewer is better — a 2+ day block off counts as a proper break and isn't included."],
                  ["Lonely shifts", "Single workdays with days off on both sides (off, work, off). Fewer is better — a shift next to another shift isn't counted."],
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
              <div>
                <label className="block text-xs font-semibold text-[#64748B] mb-1">Days off</label>
                <label className="flex items-center gap-1 text-[11px] text-[#64748B] cursor-pointer" title="Tries to group each person's days off into blocks of 2+ instead of single days scattered across the week. A preference, not a hard rule.">
                  <input type="checkbox" checked={groupDaysOff} onChange={(e) => setGroupDaysOff(e.target.checked)} />
                  Group days off together
                </label>
                <label className="flex items-center gap-1 text-[11px] text-[#64748B] cursor-pointer" title="Tries to avoid single workdays with days off on both sides. A preference, not a hard rule.">
                  <input type="checkbox" checked={avoidLonelyShifts} onChange={(e) => setAvoidLonelyShifts(e.target.checked)} />
                  Avoid lonely shifts
                </label>
              </div>
              <div>
                <label className="block text-xs font-semibold text-[#64748B] mb-1">Weekends</label>
                <label className="flex items-center gap-1 text-[11px] text-[#64748B] cursor-pointer" title="On: if it's someone's weekend to work, try to put them on the same shift both Saturday and Sunday. Off: Saturday and Sunday are filled independently, same as any other day.">
                  <input type="checkbox" checked={weekendPairingEnabled} onChange={(e) => setWeekendPairingEnabled(e.target.checked)} />
                  Pair Saturday/Sunday to the same person
                </label>
                <label className="flex items-center gap-1 text-[11px] text-[#64748B] cursor-pointer" title="On: for anyone on a weekend rotation, try to also give them the Friday before and Monday after their OFF weekend, turning it into a longer weekend. A preference, not a guarantee — it won't leave a shift empty just to stretch someone's weekend.">
                  <input type="checkbox" checked={extendOffWeekends} onChange={(e) => setExtendOffWeekends(e.target.checked)} />
                  Extend off-weekends into longer weekends
                </label>
              </div>
              <div>
                <label className="block text-xs font-semibold text-[#64748B] mb-1" title="When a shortfall can't be safely resolved and gets flagged for manual coverage, prefer taking over a PRN's shift in one of these codes (e.g. a float role) over any other shift that's up for grabs — easier on whoever ends up covering it. Pick as many as apply; none selected just means no preference.">Cushion shift(s) for flagged shortfalls</label>
                <div className="flex flex-wrap gap-1 max-w-[200px]">
                  {trainableShiftCodes.map((code) => (
                    <button
                      key={code} type="button"
                      onClick={() => setCushionShiftCodes((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]))}
                      className={`text-[10px] px-2 py-1 rounded border ${cushionShiftCodes.includes(code) ? "bg-[#0D9488] text-white border-[#0D9488]" : "bg-white text-[#64748B] border-[#E4E7EC]"}`}
                    >
                      {shiftLabel(code)}
                    </button>
                  ))}
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
              {feasibility.byShift.some((s) => s.shortfall > 0) && (
                <div>
                  <div className="text-xs font-semibold mb-1 text-[#DC2626]">⚠ Short on staff trained for a specific shift</div>
                  <p className="text-[11px] text-[#64748B] mb-1">The totals above are headcount only — this checks whether enough of that headcount is actually trained on each shift. A "fully staffed" total can still hide a shortage here.</p>
                  <table className="text-xs border-collapse">
                    <thead>
                      <tr className="text-[#64748B]">
                        <th className="text-left pr-4 py-1">Shift</th>
                        <th className="text-right pr-4 py-1">Required</th>
                        <th className="text-right pr-4 py-1">Trained &amp; available (perm + PRN)</th>
                        <th className="text-right py-1">Short</th>
                      </tr>
                    </thead>
                    <tbody>
                      {feasibility.byShift.filter((s) => s.shortfall > 0).map((s) => (
                        <tr key={s.code} className="border-t border-[#F1F5F9]">
                          <td className="pr-4 py-1">{shiftLabel(s.code)}</td>
                          <td className="text-right pr-4 py-1">{s.required}</td>
                          <td className="text-right pr-4 py-1">{s.availablePermanent} + {s.availablePrn}</td>
                          <td className="text-right py-1 text-[#DC2626] font-semibold">{s.shortfall}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {feasibility.overall.shortfall === 0 && !feasibility.weekends.some((w) => w.shortfall > 0) && !feasibility.holidays.some((h) => h.shortfall > 0) && !feasibility.byShift.some((s) => s.shortfall > 0) && (
                <div className="text-xs text-[#0D9488] font-semibold">✓ No capacity shortfall detected for this rotation.</div>
              )}
            </div>

            <div className="bg-white rounded-lg border border-[#E4E7EC] p-4">
              <div className="text-sm font-semibold mb-1">Manage shifts</div>
              <p className="text-xs text-[#64748B] mb-3">
                Your own shift roster — add as many as you need, rename any (up to 4 characters so it still fits the schedule grid), and mark which ones run on weekends/holidays.
                "Weekend only" takes it a step further — that shift never appears Monday-Friday at all, only on Saturday, Sunday, and holidays.
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
                      <th className="pr-3 py-1">Name</th>
                      <th className="pr-3 py-1 text-center">Weekend/<br />holiday?</th>
                      <th className="pr-3 py-1 text-center">Weekend<br />only?</th>
                      <th className="pr-3 py-1 text-center">Continuity?</th>
                      <th className="pr-3 py-1 text-center">Days</th>
                      <th className="pr-3 py-1 text-center">Paused?</th>
                      <th className="py-1"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {shiftDefsSorted.map((d) => (
                      <tr key={d.code} className="border-t border-[#F1F5F9]">
                        <td className="pr-3 py-1.5">
                          <div className="flex items-center gap-1.5">
                            <input
                              value={d.label || ""}
                              onChange={(e) => renameShift(d.code, e.target.value)}
                              placeholder={d.code}
                              maxLength={4}
                              className="w-16 border border-[#E4E7EC] rounded px-2 py-1 text-xs font-mono uppercase text-center"
                            />
                            {d.overflow && <span className="text-[9px] uppercase font-bold text-[#7C3AED] border border-[#DDD6FE] rounded px-1.5 py-0.5 whitespace-nowrap" title="The reserved overflow shift — tops up extended-hour staff to their guaranteed shift count. Rename it freely; pause it to turn the top-ups off.">Overflow</span>}
                          </div>
                        </td>
                        <td className="pr-3 py-1.5 text-center">
                          <input type="checkbox" checked={d.activeWeekend} onChange={() => toggleShiftWeekend(d.code)} />
                        </td>
                        <td className="pr-3 py-1.5 text-center">
                          <input type="checkbox" checked={d.weekendOnly} title="Never appears Monday-Friday — only Saturday, Sunday, and holidays." onChange={() => toggleShiftWeekendOnly(d.code)} />
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
                          {d.overflow ? (
                            <span className="text-[10px] text-[#94A3B8]" title="Reserved — use Paused above to turn off overflow top-ups instead of removing it.">Reserved</span>
                          ) : (
                            <button onClick={() => removeShiftDefinition(d.code)} className="text-[#DC2626] text-[10px]">Remove</button>
                          )}
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
              <div className="flex flex-wrap items-end gap-3 mb-4 pb-4 border-b-2 border-[#0D9488]">
                <div>
                  <label className="block text-xs font-semibold text-[#64748B] mb-1">Start date</label>
                  <input type="date" value={leaveStart} onChange={(e) => setLeaveStart(e.target.value)} className="border border-[#E4E7EC] rounded px-3 py-1.5 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-[#64748B] mb-1">End date</label>
                  <input type="date" value={leaveEnd} onChange={(e) => setLeaveEnd(e.target.value)} className="border border-[#E4E7EC] rounded px-3 py-1.5 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-[#64748B] mb-1">Type</label>
                  <div className="flex gap-1">
                    <button type="button" onClick={() => setLeaveType("PTO1")} className={`px-2.5 py-1.5 text-xs rounded border ${leaveType === "PTO1" ? "bg-[#DC2626] text-white border-[#DC2626]" : "border-[#E4E7EC] text-[#64748B]"}`}>PTO (hard)</button>
                    <button type="button" onClick={() => setLeaveType("PTO2")} className={`px-2.5 py-1.5 text-xs rounded border ${leaveType === "PTO2" ? "bg-[#F59E0B] text-white border-[#F59E0B]" : "border-[#E4E7EC] text-[#64748B]"}`}>DNS (soft)</button>
                    <button type="button" title="Overrides their normal day off/rotation to guarantee a real shift on these dates — for sparse holiday coverage. Won't override approved PTO-1; adjusts the rest of their pay period so a capped employee never goes over their max." onClick={() => setLeaveType("FORCED")} className={`px-2.5 py-1.5 text-xs rounded border ${leaveType === "FORCED" ? "bg-[#2563EB] text-white border-[#2563EB]" : "border-[#E4E7EC] text-[#64748B]"}`}>Force holiday (hard)</button>
                  </div>
                </div>
                <p className="text-xs text-[#64748B] max-w-sm">Pick PTO, DNS, or Force holiday, set the dates, then click "Block" on their row below. "Clear" (same row) undoes any of the three.</p>
              </div>
              {leaveWarning && (
                <div className="bg-[#FEF3C7] border border-[#FDE68A] text-[#92400E] text-xs rounded px-3 py-2 mb-4 flex items-start justify-between gap-3">
                  <span>⚠ {leaveWarning}</span>
                  <button onClick={() => setLeaveWarning(null)} className="underline whitespace-nowrap">Dismiss</button>
                </div>
              )}
              <div className="flex flex-wrap items-end gap-3 mb-4 pb-4 border-b-2 border-[#0D9488]">
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
                      <button
                        onClick={() => blockLeave(emp.id)} disabled={!leaveStart || !leaveEnd}
                        className="ml-auto px-2 py-1 text-[10px] rounded border disabled:opacity-30"
                        style={leaveType === "PTO2" ? { borderColor: "#F59E0B", color: "#F59E0B" } : leaveType === "FORCED" ? { borderColor: "#2563EB", color: "#2563EB" } : { borderColor: "#DC2626", color: "#DC2626" }}
                      >
                        Block
                      </button>
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
                      {emp.fixedDays.some((d) => d === 0 || d === 6) && (
                        <span className="text-[11px] text-[#7C3AED]">
                          Saturday and/or Sunday is already a fixed work day for this employee — a locked commitment that always wins, so the rotation setting above has no effect on that day.
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap pl-1">
                      <label className="text-[11px] text-[#64748B]">Trained on (unchecking excludes them from that shift):</label>
                      <div className="flex flex-wrap gap-1.5">
                        {trainableShiftCodes.map((s) => {
                          const active = emp.allowedShifts.includes(s);
                          return (
                            <button key={s} onClick={() => toggleEmployeeAllowedShift(emp.id, s)}
                              className="px-2.5 py-1 rounded text-[11px] font-mono font-semibold border"
                              style={active ? { background: getShiftColor(s), borderColor: getShiftColor(s), color: "#fff" } : { borderColor: "#E4E7EC", color: "#94A3B8" }}>{shiftLabel(s)}</button>
                          );
                        })}
                      </div>
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
                <div className="text-sm font-semibold">PTO — click a cell to cycle: available → PTO-1 (hard) → PTO-2 (soft) → force holiday work → pin an exact shift → available</div>
                <div className="flex gap-4 mt-2 text-xs flex-wrap">
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm inline-block bg-[#DC2626]" />PTO-1: honored no matter what</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm inline-block bg-[#F59E0B]" />PTO-2: honored unless the schedule can't cover without them</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm inline-block bg-[#DC2626]" style={{ border: "2px dashed #7C3AED" }} />dashed border = auto-set by weekend rotation</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm inline-block bg-[#F8FAFC] relative" style={{ border: "1px solid #E4E7EC" }}><span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-[#2563EB] border border-white" /></span>blue dot = forced holiday work (overrides their normal day off)</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm inline-block bg-[#2563EB]" style={{ border: "2px solid #2563EB" }} />colored cell showing a code = a pinned shift (you chose the exact code; click to clear)</span>
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
                          const forced = !!forcedHolidayWork[k];
                          const pinnedCode = pinnedShifts[k];
                          if (pinPickerCell === k) {
                            return (
                              <td key={d.idx} className="border-b border-[#F1F5F9] p-0.5">
                                <select
                                  autoFocus
                                  defaultValue=""
                                  onChange={(e) => commitPin(emp.id, d.idx, e.target.value)}
                                  onBlur={() => setPinPickerCell((prev) => (prev === k ? null : prev))}
                                  title="Pick the exact shift code to pin this employee to on this date — the generator locks it in and builds the rest of the schedule around it."
                                  className="w-6 h-6 text-[8px] rounded-sm border-2 border-[#2563EB]"
                                >
                                  <option value="">✕</option>
                                  {trainableShiftCodes.map((code) => <option key={code} value={code}>{shiftLabel(code)}</option>)}
                                </select>
                              </td>
                            );
                          }
                          return (
                            <td key={d.idx} className="border-b border-[#F1F5F9] p-0.5">
                              <button
                                onClick={() => cyclePto(emp.id, d.idx)}
                                title={[
                                  autoGenerated ? "Auto-set by weekend rotation — click to override" : null,
                                  forced ? "Tagged to force a real shift this day — click to clear" : null,
                                  pinnedCode ? `Pinned to ${shiftLabel(pinnedCode)} — the generator will build the rest of the schedule around this. Click to clear.` : null,
                                ].filter(Boolean).join(" · ") || undefined}
                                className="w-6 h-6 rounded-sm relative font-mono font-semibold"
                                style={{
                                  background: pinnedCode ? getShiftColor(pinnedCode) : st === "PTO1" ? "#DC2626" : st === "PTO2" ? "#F59E0B" : d.isWeekend ? "#F1F5F9" : "#F8FAFC",
                                  color: pinnedCode ? "#fff" : undefined,
                                  fontSize: pinnedCode ? gridCellFontSize(shiftLabel(pinnedCode)) : undefined,
                                  border: pinnedCode ? "2px solid #2563EB" : autoGenerated ? "2px dashed #7C3AED" : (st === "PTO1" || st === "PTO2") ? "3px solid #000" : "1px solid #E4E7EC",
                                }}
                              >
                                {pinnedCode ? shiftLabel(pinnedCode) : null}
                                {forced && <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-[#2563EB] border border-white" />}
                              </button>
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
                <p className="text-xs text-[#64748B] max-w-sm">Everything else — extended hours, available days, individual dates — can be set on their row below once they're added.</p>
              </div>
              <div className="text-xs font-semibold text-[#64748B] mb-1">Trained on (locks which shifts they can fill):</div>
              <div className="flex flex-wrap gap-2">
                {trainableShiftCodes.map((s) => {
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
                <div className="text-sm font-semibold mb-1">PRN roster</div>
                <p className="text-xs text-[#64748B] mb-3">Same controls as Permanent Staff, with one addition — "Available days" fills the grid below for you instead of clicking each day by hand.</p>
                <div className="flex flex-wrap items-end gap-3 mb-4 pb-4 border-b border-[#F1F5F9]">
                  <div>
                    <label className="block text-xs font-semibold text-[#64748B] mb-1">PTO start</label>
                    <input type="date" value={leaveStart} onChange={(e) => setLeaveStart(e.target.value)} className="border border-[#E4E7EC] rounded px-3 py-1.5 text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#64748B] mb-1">PTO end</label>
                    <input type="date" value={leaveEnd} onChange={(e) => setLeaveEnd(e.target.value)} className="border border-[#E4E7EC] rounded px-3 py-1.5 text-sm" />
                  </div>
                  <p className="text-xs text-[#64748B] max-w-sm">For approved PTO only. Set the dates, then click "Block" on their row below — removes them completely for that span, no exceptions, no soft DNS option like permanent staff's PTO-2. "Clear" (same row) restores their normal pattern.</p>
                </div>
                <div className="space-y-3">
                  {extra.map((e) => (
                    <div key={e.id} className="flex flex-col gap-1.5 pb-3 border-b border-[#EDE9FE] last:border-b-0 last:pb-0 bg-[#F5F3FF] border-l-4 border-l-[#7C3AED] rounded px-3 py-2">
                      <div className="flex items-center gap-3 flex-wrap">
                        <span className="text-[9px] uppercase font-bold text-[#7C3AED] border border-[#DDD6FE] rounded px-1.5 py-0.5">PRN</span>
                        <input value={e.name} onChange={(ev) => setEmployees((prev) => prev.map((p) => (p.id === e.id ? { ...p, name: ev.target.value } : p)))} onBlur={() => upsertEmployee(e, viewingOwnerId).catch(reportSyncError)} className="text-sm border border-[#E4E7EC] rounded px-2 py-1 w-32" />
                        <button onClick={() => blockExtraLeave(e.id)} disabled={!leaveStart || !leaveEnd} className="ml-auto px-2 py-1 text-[10px] rounded border border-[#DC2626] text-[#DC2626] hover:bg-[#DC2626] hover:text-white disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[#DC2626]">Block</button>
                        <button onClick={() => clearExtraLeave(e.id)} disabled={!leaveStart || !leaveEnd} className="px-2 py-1 text-[10px] rounded border border-[#E4E7EC] text-[#64748B] hover:bg-white disabled:opacity-30">Clear</button>
                        <button onClick={() => convertToPermanent(e.id)} className="px-2 py-1 text-[10px] rounded border border-[#0D9488] text-[#0D9488] hover:bg-[#0D9488] hover:text-white whitespace-nowrap">Convert to permanent →</button>
                        <button onClick={() => removeEmployee(e)} className="px-2 py-1 text-[10px] text-[#DC2626]">Remove</button>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap pl-1">
                        <label className="flex items-center gap-1.5 text-[11px] text-[#64748B] cursor-pointer">
                          <input type="checkbox" checked={!!e.shiftCap} onChange={(ev) => setEmployeeShiftCap(e.id, ev.target.checked ? { windowDays: 14, maxShifts: 5 } : null)} />
                          Extended-hour schedule (caps shifts per period)
                        </label>
                        {e.shiftCap && (
                          <span className="flex items-center gap-1 text-[11px] text-[#64748B]">
                            max
                            <input type="number" min={1} value={e.shiftCap.maxShifts} onChange={(ev) => setEmployeeShiftCap(e.id, { ...e.shiftCap, maxShifts: Math.max(1, Number(ev.target.value) || 1) })} className="w-12 border border-[#E4E7EC] rounded px-1 py-0.5 text-center" />
                            shifts per
                            <input type="number" min={1} value={e.shiftCap.windowDays} onChange={(ev) => setEmployeeShiftCap(e.id, { ...e.shiftCap, windowDays: Math.max(1, Number(ev.target.value) || 1) })} className="w-12 border border-[#E4E7EC] rounded px-1 py-0.5 text-center" />
                            days
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-wrap pl-1">
                        <label className="text-[11px] text-[#64748B]">Available days:</label>
                        <div className="flex gap-1">
                          {DOW.map((d, dow) => {
                            const active = e.availableDaysOfWeek.includes(dow);
                            return <button key={dow} onClick={() => toggleExtraAvailableDow(e.id, dow)} className={`w-8 h-7 text-[10px] rounded border ${active ? "bg-[#7C3AED] text-white border-[#7C3AED]" : "border-[#E4E7EC] text-[#64748B]"}`}>{d[0]}</button>;
                          })}
                        </div>
                        <button onClick={() => applyAvailabilityPattern(e.id)} disabled={e.availableDaysOfWeek.length === 0} className="px-2 py-1 text-[10px] rounded border border-[#7C3AED] text-[#7C3AED] hover:bg-[#7C3AED] hover:text-white disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[#7C3AED] whitespace-nowrap">Apply to grid below →</button>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap pl-1">
                        <label className="text-[11px] text-[#64748B]">Trained on:</label>
                        <div className="flex flex-wrap gap-1.5">
                          {trainableShiftCodes.map((s) => {
                            const active = e.allowedShifts.includes(s);
                            return (
                              <button key={s} onClick={() => toggleEmployeeAllowedShift(e.id, s)}
                                className="px-2.5 py-1 rounded text-[11px] font-mono font-semibold border"
                                style={active ? { background: getShiftColor(s), borderColor: getShiftColor(s), color: "#fff" } : { borderColor: "#E4E7EC", color: "#94A3B8" }}>{shiftLabel(s)}</button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {extra.length > 0 && (
              <div className="bg-white rounded-lg border border-[#E4E7EC] overflow-hidden">
                <div className="px-4 py-3 border-b border-[#E4E7EC] text-sm font-semibold">Availability — click a day to toggle it on/off (default: unavailable)</div>
                <p className="px-4 pt-2 text-xs text-[#64748B]">"Apply to grid below" on a person's row above fills this in from their weekly pattern — it only ever adds days, so a day you've removed here stays removed unless you click it again or re-apply.</p>
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
              {schedule.iterations > 0 ? (
                <>
                  <span>Fairness score before optimizer: <b>{schedule.costBefore.toFixed(1)}</b></span>
                  <span>→ after {schedule.iterations.toLocaleString()} passes: <b>{schedule.costAfter.toFixed(1)}</b></span>
                  <span>({schedule.costBefore > 0 ? Math.round((1 - schedule.costAfter / schedule.costBefore) * 100) : 0}% improvement)</span>
                </>
              ) : (
                <span>Current fairness score (as of your last change): <b>{schedule.costAfter.toFixed(1)}</b> — no optimizer pass has run against this exact grid; click "Fairness check" any time to re-tabulate.</span>
              )}
            </div>
            {schedule.totalHoles > 0 && (
              <AlertBox tone="critical" dismissKey={`holes:${schedule.totalHoles}`}>
                ⚠ {schedule.totalHoles} shift(s) are mathematically unfillable given current staff, PTO, and qualifications — see red "HOLE" cells below.
              </AlertBox>
            )}
            {schedule.totalOverrides > 0 && (
              <AlertBox tone="advisory" dismissKey={`overrides:${schedule.totalOverrides}`}>
                ℹ {schedule.totalOverrides} shift(s) had to pull someone off their requested PTO-2 day (marked with *).
              </AlertBox>
            )}
            {schedule.continuityCheck.violations.length > 0 && (
              <AlertBox tone="critical" dismissKey={`continuity:${schedule.continuityCheck.violations.join("|")}`}>
                ⚠ Continuity rule violations detected:
                <AlertList items={schedule.continuityCheck.violations} />
              </AlertBox>
            )}
            {schedule.shiftCapViolations.length > 0 && (
              <AlertBox tone="critical" dismissKey={`capViol:${schedule.shiftCapViolations.join("|")}`}>
                ⚠ Shift-cap violations detected:
                <AlertList items={schedule.shiftCapViolations} />
              </AlertBox>
            )}
            {schedule.cappedFixedDayViolations.length > 0 && (
              <AlertBox tone="critical" dismissKey={`fixedDay:${schedule.cappedFixedDayViolations.join("|")}`}>
                ⚠ Fixed-day violations detected:
                <AlertList items={schedule.cappedFixedDayViolations} />
              </AlertBox>
            )}
            {schedule.employeesMissingShifts > 0 && (
              <AlertBox tone="advisory" dismissKey={`missingTypes:${schedule.employeesMissingShifts}`}>
                ℹ {schedule.employeesMissingShifts} employee(s) didn't get at least one of every active shift type this rotation — see Fairness Report for details.
              </AlertBox>
            )}
            {schedule.guaranteeGaps > 0 && (
              <AlertBox tone="critical" dismissKey={`guaranteeGaps:${schedule.guaranteeGaps}`}>
                ⚠ {schedule.guaranteeGaps} pay period(s) are short of the guaranteed shift count — every safe day would break the consecutive-day limit, usually because a weekend-paired or continuity day sits right at the pay-period boundary. Flagged on the grid with a red "!" — assign by hand or relax the consecutive-day limit.
              </AlertBox>
            )}
            {schedule.weekendPairingMismatches.length > 0 && (
              <AlertBox tone="advisory" dismissKey={`weekendPairing:${schedule.weekendPairingMismatches.join("|")}`}>
                ℹ {schedule.weekendPairingMismatches.length} weekend(s) couldn't be paired to the same person — nobody permanent was free both days, so it fell back to covering each day separately:
                <AlertList items={schedule.weekendPairingMismatches} />
              </AlertBox>
            )}
            {schedule.forcedHolidayConflicts?.length > 0 && (
              <AlertBox tone="critical" dismissKey={`forcedHoliday:${schedule.forcedHolidayConflicts.join("|")}`}>
                ⚠ {schedule.forcedHolidayConflicts.length} forced holiday-work tag(s) couldn't be honored:
                <AlertList items={schedule.forcedHolidayConflicts} />
              </AlertBox>
            )}
            {schedule.pinnedShiftConflicts?.length > 0 && (
              <AlertBox tone="critical" dismissKey={`pinnedConflict:${schedule.pinnedShiftConflicts.join("|")}`}>
                ⚠ {schedule.pinnedShiftConflicts.length} pinned shift(s) couldn't be honored:
                <AlertList items={schedule.pinnedShiftConflicts} />
              </AlertBox>
            )}
            {schedule.pinnedShiftWarnings?.length > 0 && (
              <AlertBox tone="advisory" dismissKey={`pinnedWarn:${schedule.pinnedShiftWarnings.join("|")}`}>
                ℹ {schedule.pinnedShiftWarnings.length} pinned shift(s) scheduled for someone not trained on that code:
                <AlertList items={schedule.pinnedShiftWarnings} />
              </AlertBox>
            )}
            {manualEditWarnings.length > 0 && (
              <AlertBox tone="advisory" onDismiss={() => setManualEditWarnings([])}>
                ℹ After your last move:
                <AlertList items={manualEditWarnings} />
              </AlertBox>
            )}
            {missingShiftReport != null && (
              missingShiftReport.length > 0 ? (
                <AlertBox tone="advisory" onDismiss={() => setMissingShiftReport(null)}>
                  🔍 {missingShiftReport.length} pay-period shortfall(s) found — look for the dotted amber "+" cells below:
                  <AlertList items={missingShiftReport} />
                </AlertBox>
              ) : (
                <AlertBox tone="success" onDismiss={() => setMissingShiftReport(null)}>
                  ✓ Scan complete — no permanent staff are short their pay-period minimum right now.
                </AlertBox>
              )
            )}
            <div className="bg-[#EFF6FF] border border-[#BFDBFE] text-[#1E3A8A] text-xs rounded px-3 py-2">
              ✋ Drag any shift cell onto another to swap them by hand — a small teal dot marks a cell you've moved. Dropping onto an empty cell moves the shift instead of swapping it; an amber dashed cell with a "−" marks wherever that leaves someone short. Fairness Report, Optimization, and Export CSV all update to match. Locked-leave days and continuity shifts can't be dragged onto or moved.
            </div>
            {(gapsList.length > 0 || overflowDaysList.length > 0) && (
              <div className="bg-white rounded-lg border border-[#E4E7EC] p-4">
                {gapsList.length > 0 && (
                  <>
                    <div className="text-sm font-semibold mb-1">Fill a coverage gap</div>
                    <p className="text-xs text-[#64748B] mb-3">Pick who covers each empty shift below — same as a drag-and-drop move, so Fairness Report, Optimization, and Export CSV all update to match. You'll get a warning (not a block) if they're not trained for it or it pushes them over a limit.</p>
                    <div className="space-y-2">
                      {gapsList.map(({ day, code }) => (
                        <div key={`${day.idx}-${code}`} className="flex items-center gap-2 flex-wrap text-xs">
                          <span className="px-2 py-1 rounded font-mono font-semibold text-white min-w-[48px] text-center" style={{ background: getShiftColor(code) }}>{shiftLabel(code)}</span>
                          <span className="text-[#64748B] w-20">{day.wd} {day.md}</span>
                          <select
                            defaultValue=""
                            onChange={(e) => {
                              if (!e.target.value) return;
                              const chosen = [...permanent, ...extra].find((x) => String(x.id) === e.target.value);
                              if (chosen) applyManualFill(chosen, day.idx, code);
                            }}
                            className="border border-[#E4E7EC] rounded px-2 py-1 text-xs"
                          >
                            <option value="">Assign to…</option>
                            {eligibleCandidatesFor(day, code).map((c) => (
                              <option key={c.id} value={c.id}>{c.name}{c.type === "extra" ? " (PRN)" : ""}{!c.trained ? " — not trained" : ""}</option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {overflowDaysList.length > 0 && (
                  <div className={gapsList.length > 0 ? "mt-4 pt-3 border-t border-[#E4E7EC]" : ""}>
                    <div className="text-sm font-semibold mb-1">Days with spare (E0) coverage</div>
                    <p className="text-xs text-[#64748B] mb-2">Someone's already padded up beyond what the day needs on these days — a safer first look if you need to approve a PTO request. Amber ones include someone flagged there by force (a consecutive-day override), not a comfortable cushion — check their row before counting on it.</p>
                    <div className="flex flex-wrap gap-2 text-xs">
                      {overflowDaysList.map(({ day, names, phantomNames }) => {
                        const hasPhantom = phantomNames.length > 0;
                        const title = [
                          names.length ? `Spare: ${names.join(", ")}` : null,
                          hasPhantom ? `Forced (flagged, needs coverage): ${phantomNames.join(", ")}` : null,
                        ].filter(Boolean).join(" — ");
                        return (
                          <span
                            key={day.idx}
                            className={hasPhantom ? "px-2 py-1 rounded bg-[#FEF3C7] border border-[#FDE68A] text-[#92400E]" : "px-2 py-1 rounded bg-[#F0FDFA] border border-[#99F6E4] text-[#0D9488]"}
                            title={title}
                          >
                            {day.wd} {day.md} · {names.length + phantomNames.length}{hasPhantom ? " ⚠" : ""}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="bg-white rounded-lg border border-[#E4E7EC] p-4">
              <div className="text-sm font-semibold mb-1">Add overflow (E0) coverage</div>
              <p className="text-xs text-[#64748B] mb-3">Always here, independent of any actual coverage gap — E0 is never a hole, so it's not covered by "Fill a coverage gap" above. Pad any day with a permanent employee's extra body as a cushion against a shortfall, before one even shows up. Never overwrites anyone already on E0 that day; it just adds alongside them.</p>
              <div className="flex items-center gap-2 flex-wrap text-xs">
                <select
                  value={overflowAssignDay}
                  onChange={(e) => setOverflowAssignDay(e.target.value)}
                  className="border border-[#E4E7EC] rounded px-2 py-1 text-xs"
                >
                  <option value="">Day…</option>
                  {schedule.days.map((d) => (
                    <option key={d.idx} value={d.idx}>{d.wd} {d.md}</option>
                  ))}
                </select>
                <select
                  key={overflowAssignDay}
                  defaultValue=""
                  disabled={overflowAssignDay === ""}
                  onChange={(e) => {
                    if (!e.target.value || overflowAssignDay === "") return;
                    const chosen = permanent.find((x) => String(x.id) === e.target.value);
                    if (chosen) { applyOverflowFill(chosen, Number(overflowAssignDay)); setOverflowAssignDay(""); }
                  }}
                  className="border border-[#E4E7EC] rounded px-2 py-1 text-xs disabled:bg-[#F8FAFC] disabled:text-[#94A3B8]"
                >
                  <option value="">{overflowAssignDay === "" ? "Pick a day first…" : "Assign to…"}</option>
                  {overflowAssignDay !== "" && overflowCandidatesFor(Number(overflowAssignDay)).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex items-center gap-3 flex-wrap text-xs">
              <div className="text-[#64748B]">Legend:</div>
              {ALL_SHIFT_CODES.map((s) => <div key={s} className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm inline-block" style={{ background: getShiftColor(s) }} />{shiftLabel(s)}{isContinuityCode(s) ? "†" : ""}</div>)}
              <div className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm inline-block bg-[#E4E7EC]" />OFF</div>
              <div className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm inline-block bg-[#DC2626]" />PTO-1</div>
              <div className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm inline-block bg-[#DC2626]" style={{ border: "2px dashed #7C3AED" }} />WKND (off per rotation, not leave)</div>
              <div className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm inline-block bg-[#F59E0B]" />PTO-2</div>
              <div className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm inline-block" style={{ border: "3px dashed #2563EB" }} />forced holiday work</div>
              <div className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm inline-block" style={{ border: "3px solid #2563EB" }} />manually pinned shift</div>
              <div className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm inline-block bg-[#E4E7EC]" style={{ border: "2px dashed #F59E0B" }} />lost a shift with nothing given back (now likely short)</div>
              <div className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm inline-block bg-[#E4E7EC]" style={{ border: "2px dotted #F59E0B" }} />"Scan for missing shifts" suggests this day</div>
              <div className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm inline-flex items-center justify-center text-[10px] font-semibold bg-[#F8FAFC] border border-[#1A2233]">Σ</span>shifts actually worked this pay period (no PTO/days off)</div>
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={scanForMissingShifts}
                  title="Checks every permanent employee against their own pay-period minimum (PTO-1 counted toward it) on the CURRENT grid, and flags the best open day to cover any shortfall it finds."
                  className="px-3 py-1.5 text-xs font-semibold rounded border border-[#CA8A04] text-[#CA8A04] hover:bg-[#CA8A04] hover:text-white"
                >
                  🔍 Scan for missing shifts
                </button>
                {[1, 2].map((slot) => (
                  <div key={slot} className="flex items-center gap-1">
                    {scheduleSlots[slot] ? (
                      <>
                        <button
                          onClick={() => loadFromSlot(slot)}
                          title={`Load this schedule, saved ${new Date(scheduleSlots[slot].savedAt).toLocaleString()}. Replaces what's on screen now — unsaved manual edits are lost.`}
                          className="px-3 py-1.5 text-xs font-semibold rounded border border-[#64748B] text-[#64748B] hover:bg-[#64748B] hover:text-white"
                        >
                          📂 {slotLabel(slot)} · {new Date(scheduleSlots[slot].savedAt).toLocaleDateString(undefined, { month: "numeric", day: "numeric" })} {new Date(scheduleSlots[slot].savedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                        </button>
                        <button onClick={() => renameSlot(slot)} title={`Rename ${slotLabel(slot)}`} className="px-2 py-1.5 text-xs rounded border border-[#E4E7EC] text-[#64748B] hover:bg-[#F8FAFC]">
                          ✏️
                        </button>
                        <button onClick={() => saveToSlot(slot)} title={`Overwrite ${slotLabel(slot)} with the current schedule`} className="px-2 py-1.5 text-xs rounded border border-[#E4E7EC] text-[#64748B] hover:bg-[#F8FAFC]">
                          💾
                        </button>
                      </>
                    ) : (
                      <button onClick={() => saveToSlot(slot)} title="Save the current schedule here to come back to later — regenerating or editing won't touch it" className="px-3 py-1.5 text-xs font-semibold rounded border border-[#E4E7EC] text-[#64748B] hover:bg-[#F8FAFC]">
                        💾 Save to File name {slot}
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <button
                onClick={() => downloadScheduleCsv({ schedule, permanent, extra, ptoStatus, ptoSource, holidays, key, shiftLabel }, `schedule_${startDate}_${numWeeks}w.csv`)}
                className="px-3 py-1.5 text-xs font-semibold rounded border border-[#0D9488] text-[#0D9488] hover:bg-[#0D9488] hover:text-white"
              >
                ⬇ Export CSV
              </button>
              <button onClick={generate} disabled={generating} className="px-3 py-1.5 text-xs font-semibold rounded bg-[#0D9488] text-white hover:bg-[#0B6B62] disabled:opacity-50">
                {generating ? "Working…" : "↻ Regenerate"}
              </button>
              <span className="flex items-center gap-1 text-xs text-[#64748B]">
                <label htmlFor="code-repeat-cooldown" title="How many of an employee's own other worked days must pass before the same shift code can land on them again. Defaults to a full cycle through your current shift list.">N:</label>
                <select
                  id="code-repeat-cooldown"
                  value={codeRepeatCooldown ?? rotationCodes.length}
                  onChange={(e) => setCodeRepeatCooldown(Number(e.target.value))}
                  className="border border-[#E4E7EC] rounded px-1.5 py-1"
                >
                  {[0, -2, -4, -6].map((delta) => rotationCodes.length + delta).filter((n) => n >= 1).map((n) => (
                    <option key={n} value={n}>{n}{n === rotationCodes.length ? " (full cycle)" : ""}</option>
                  ))}
                </select>
              </span>
              <button
                onClick={regenerateByRotation}
                disabled={generatingRotation}
                title={`Reshuffles what's already on screen — never decides who works which days, so nobody's total shift count changes. Swaps which code two people already working the same day are down for, whenever that gets them closer to N (${codeRepeatCooldown ?? rotationCodes.length}, pick it from the dropdown) of their own other worked days since that exact code last landed on them. Only swaps people each trained for the other's code. Weekends, holidays, pins, continuity blocks, phantom slots, and PRN coverage are never touched. Repeats that can't be fixed this way aren't flagged on the grid — "Fairness check" counts them as Early repeats instead.`}
                className="px-3 py-1.5 text-xs font-semibold rounded border border-[#7C3AED] text-[#7C3AED] hover:bg-[#7C3AED] hover:text-white disabled:opacity-50"
              >
                {generatingRotation ? "Rotating…" : "Regenerate-N"}
              </button>
              <button
                onClick={checkFairness}
                title="Pure re-scan, no changes to the grid — re-tabulates every fairness number (the Fairness Report table, the distribution & streak summary, every violation check) from whatever's on screen right now, and replaces the top banner's fairness score with a fresh current reading instead of a stale one left over from the last real Generate."
                className="px-3 py-1.5 text-xs font-semibold rounded border border-[#0D9488] text-[#0D9488] hover:bg-[#0D9488] hover:text-white"
              >
                ✓ Fairness check
              </button>
              <button
                onClick={undoLastChange}
                disabled={undoStack.length === 0}
                title={undoStack.length > 0 ? `Undo the last change (${undoStack.length} step${undoStack.length === 1 ? "" : "s"} available this session) — covers Regenerate, Regenerate-N, drags, gap fills, and loading a slot.` : "Nothing to undo yet this session."}
                className="px-3 py-1.5 text-xs font-semibold rounded border border-[#64748B] text-[#64748B] hover:bg-[#64748B] hover:text-white disabled:opacity-50"
              >
                ↶ Undo{undoStack.length > 0 ? ` (${undoStack.length})` : ""}
              </button>
            </div>
            {renderScheduleTable(permanent, "Permanent staff")}
            {extra.length > 0 && renderScheduleTable(extra, "PRN / as-needed staff")}
          </div>
        )}

        {tab === "optimization" && schedule && (
          <OptimizationTab tips={optimizationTips} />
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
              <div className="text-sm font-semibold mb-2">Shift distribution & longest streak</div>
              <p className="text-xs text-[#64748B] mb-3">A quick look at how evenly shifts spread out per person, and the longest run of back-to-back days anyone worked — handy right after Regenerate-N to eyeball how even the rotation came out. <b>Total</b> is every shift they're actually down for however it got there — pinned shifts and weekend shifts count toward it too, same as a plain rotation pick. <b>Early repeats</b> is how many times they got the exact same shift code again before working through {codeRepeatCooldown ?? rotationCodes.length} of their own other turns first — the "was it evenly spaced out, not just evenly counted" check. The full table below also has PTO, lonely days, and missing-shift-type detail.</p>
              <table className="text-xs border-collapse w-full">
                <thead>
                  <tr className="bg-[#F7F8FA]">
                    <th className="text-left px-3 py-2 border-b border-[#E4E7EC]">Employee</th>
                    <th className="px-2 py-2 border-b border-[#E4E7EC]">Total</th>
                    <th className="px-2 py-2 border-b border-[#E4E7EC]">Longest streak</th>
                    <th className="px-2 py-2 border-b border-[#E4E7EC]" title={`How many times the same shift code repeated for them before ${codeRepeatCooldown ?? rotationCodes.length} of their own other turns had passed`}>Early repeats</th>
                    <th className="px-3 py-2 border-b border-[#E4E7EC] text-left">Distribution</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.fairness.map((f) => {
                    // Trained codes, plus anything untrained they still
                    // picked up (E0 overflow padding, mainly) — so the
                    // bars always add up to exactly the Total column,
                    // nothing silently left out of the picture.
                    const displayCodes = ALL_SHIFT_CODES.filter((s) => f.allowedShifts.includes(s) || f.perShift[s] > 0);
                    const max = Math.max(...displayCodes.map((s) => f.perShift[s]), 1);
                    return (
                      <tr key={f.id}>
                        <td className="px-3 py-1.5 border-b border-[#F1F5F9] font-medium">{f.name}</td>
                        <td className="px-2 py-1.5 border-b border-[#F1F5F9] text-center font-semibold">{f.total}</td>
                        <td className="px-2 py-1.5 border-b border-[#F1F5F9] text-center">{f.longestRun} day{f.longestRun === 1 ? "" : "s"}{f.longestRunExceeded && <span title={`Worked ${f.longestRun} days in a row — over your ${maxConsecutiveDays}-day preference`} className="text-[#DC2626] ml-1">⚠</span>}</td>
                        <td className="px-2 py-1.5 border-b border-[#F1F5F9] text-center">{f.earlyRepeats > 0 ? <span className="text-[#CA8A04] font-semibold">{f.earlyRepeats}</span> : <span className="text-[#0D9488]">0</span>}</td>
                        <td className="px-3 py-1.5 border-b border-[#F1F5F9]">
                          <div className="flex items-end gap-1.5">
                            {displayCodes.map((s) => (
                              <div key={s} className="flex flex-col items-center" title={shiftLabel(s)}>
                                <div className="flex items-end h-6">
                                  <div style={{ background: getShiftColor(s), height: `${Math.max((f.perShift[s] / max) * 100, 12)}%`, width: "6px" }} className="rounded-sm" />
                                </div>
                                <div className="text-[9px] text-[#64748B] leading-tight">{f.perShift[s]}</div>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
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
                    <th className="px-2 py-2 border-b border-[#E4E7EC]" title="Single days off with work on both sides — a 2+ day block off is not counted">Lonely days off</th>
                    <th className="px-2 py-2 border-b border-[#E4E7EC]" title="Single workdays with days off on both sides">Lonely shifts</th>
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
                        <td className="px-2 py-1.5 border-b border-[#F1F5F9] text-center">{f.lonelyDaysOff}</td>
                        <td className="px-2 py-1.5 border-b border-[#F1F5F9] text-center">{f.lonelyShifts}</td>
                        <td className="px-2 py-1.5 border-b border-[#F1F5F9] text-center">
                          {f.missingShifts.length > 0
                            ? <span className="text-[#DC2626] font-semibold" title={`Never worked: ${f.missingShifts.map(shiftLabel).join(", ")}`}>⚠ {f.missingShifts.map(shiftLabel).join(", ")}</span>
                            : <span className="text-[#0D9488]">✓</span>}
                        </td>
                        {ALL_SHIFT_CODES.map((s) => {
                          const trained = f.allowedShifts.includes(s);
                          return (
                            <td key={s} title={trained ? undefined : "Not trained on this shift"} className={`px-2 py-1.5 border-b border-[#F1F5F9] text-center ${!trained ? "text-[#CBD5E1] bg-[#F7F8FA]" : f.missingShifts.includes(s) ? "text-[#DC2626] font-semibold" : ""}`}>
                              {trained ? f.perShift[s] : "—"}
                            </td>
                          );
                        })}
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

        {tab === "import" && profile.role === "admin" && (
          <div className="space-y-4 max-w-2xl">
            <div className="bg-[#EFF6FF] border border-[#BFDBFE] text-[#1E3A8A] text-xs rounded px-3 py-2">
              Copies data from another account into whichever one you're currently viewing/editing above ({allProfiles.find((p) => p.id === viewingOwnerId)?.name || "you"}). Whatever's checked below gets completely overwritten there — this can't be undone.
            </div>
            <div className="bg-white rounded-lg border border-[#E4E7EC] p-4 space-y-3">
              <div className="flex items-center gap-2">
                <label className="text-sm font-semibold w-20">From:</label>
                <select
                  value={importSourceId}
                  onChange={(e) => setImportSourceId(e.target.value)}
                  className="border border-[#E4E7EC] rounded px-2 py-1.5 text-sm flex-1"
                >
                  <option value="">Choose an account…</option>
                  {allProfiles.filter((p) => p.id !== viewingOwnerId).map((p) => (
                    <option key={p.id} value={p.id}>{p.name || p.id}{p.role === "admin" ? " — admin" : ""}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={importSections.setup} onChange={() => toggleImportSection("setup")} />
                  Setup <span className="text-xs text-[#64748B]">— shift list, holidays, and (if the source has a saved schedule) rotation/generator settings</span>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={importSections.permanent} onChange={() => toggleImportSection("permanent")} />
                  Permanent staff <span className="text-xs text-[#64748B]">— roster, PTO, pins, forced-holiday-work</span>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={importSections.prn} onChange={() => toggleImportSection("prn")} />
                  PRN staff <span className="text-xs text-[#64748B]">— roster, availability</span>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={importSections.schedule} onChange={() => toggleImportSection("schedule")} />
                  Schedule <span className="text-xs text-[#64748B]">— the active grid (also pulls in Permanent + PRN automatically — a schedule means nothing without the matching roster)</span>
                </label>
              </div>
              <button
                onClick={runImport}
                disabled={!importSourceId || importRunning || !(importSections.setup || importSections.permanent || importSections.prn || importSections.schedule)}
                className="px-4 py-2 text-sm font-semibold rounded bg-[#7C3AED] text-white hover:bg-[#6D28D9] disabled:opacity-50"
              >
                {importRunning ? "Importing…" : "⇩ Import"}
              </button>
            </div>
            {importResult && (
              <div className={`text-sm rounded px-3 py-2 ${importResult.error ? "bg-[#FEE2E2] border border-[#DC2626] text-[#991B1B]" : "bg-[#ECFDF5] border border-[#A7F3D0] text-[#065F46]"}`}>
                {importResult.error ? <div className="font-semibold mb-1">Import failed partway through: {importResult.error}</div> : <div className="font-semibold mb-1">Import complete.</div>}
                <AlertList items={importResult.summary} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
