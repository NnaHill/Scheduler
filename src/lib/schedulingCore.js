// Pure, framework-free scheduling rules shared by the real matching
// algorithm (App.jsx) and anything that needs to estimate outcomes
// without actually running it (feasibility.js). Nothing here reads
// component state — everything is passed in as plain arguments — so
// the two stay guaranteed-consistent: change a rule once, here, and
// both the algorithm and the estimator see the same behavior.

export function toLocalISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function nextMonday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = (8 - day) % 7 || 7;
  d.setDate(d.getDate() + (day === 1 ? 0 : diff));
  return toLocalISO(d);
}
export function fmtLabel(date) {
  return {
    wd: date.toLocaleDateString(undefined, { weekday: "short" }),
    md: date.toLocaleDateString(undefined, { month: "numeric", day: "numeric" }),
  };
}
export const key = (id, idx) => `${id}_${idx}`;

// Strongly prefer a candidate who has never worked this shift code yet,
// so every employee gets exposure to every active shift over a rotation
// instead of the same few people accumulating all of one code.
export const NEVER_WORKED_BONUS = -5000;
export const shiftPref = (statEntry, shift) => (statEntry.shiftCount[shift] === 0 ? NEVER_WORKED_BONUS : 0) + statEntry.shiftCount[shift];

// Rolling shift-count cap for employees on compressed/extended-hour
// schedules (e.g. "at most 7 shifts in any 14-day window" for someone
// hitting 80 hours/week on >8hr shifts). An employee's `shiftCap` is
// either { windowDays, maxShifts } or null/undefined for no cap — add
// more capped employees, or change the ratio, purely through that data;
// nothing below needs to change.
//
// Checks every window anchored at an actual worked day (existing days
// plus the day(s) being proposed), not just a single backward-looking
// window. That matters because callers fall into two different shapes:
// during initial construction, days are decided strictly in chronological
// order, so only prior days exist yet and a backward check would suffice
// — but local search optimizes an already-fully-built schedule, where a
// candidate may already have LATER days assigned too. A backward-only
// check misses windows that include those later days, so this scans in
// both directions and works correctly for both callers.
export function wouldExceedShiftCap(emp, existingWorkedDayIndices, proposedDayIndices) {
  if (!emp.shiftCap) return false;
  const { windowDays, maxShifts } = emp.shiftCap;
  const allDays = [...existingWorkedDayIndices, ...proposedDayIndices];
  for (const anchor of allDays) {
    const count = allDays.filter((idx) => idx >= anchor && idx < anchor + windowDays).length;
    if (count > maxShifts) return true;
  }
  return false;
}
// Longest run of back-to-back calendar days in a set of worked-day
// indices (duplicates and out-of-order input are both fine). Shared by
// the soft cost penalty (how far over, for local search to chase down)
// and the hard "would this push someone over the line" check below —
// one definition of "consecutive run" for both.
export function longestConsecutiveRun(dayIndices) {
  if (dayIndices.length === 0) return 0;
  const sorted = [...new Set(dayIndices)].sort((a, b) => a - b);
  let longest = 1, current = 1;
  for (let i = 1; i < sorted.length; i++) {
    current = sorted[i] === sorted[i - 1] + 1 ? current + 1 : 1;
    longest = Math.max(longest, current);
  }
  return longest;
}
// Hard version of the consecutive-days preference — mirrors
// wouldExceedShiftCap's shape exactly (existing + proposed days in,
// boolean out) so it drops into the same call sites.
export function wouldExceedConsecutiveDays(existingWorkedDayIndices, proposedDayIndices, maxConsecutiveDays) {
  if (!maxConsecutiveDays) return false;
  return longestConsecutiveRun([...existingWorkedDayIndices, ...proposedDayIndices]) > maxConsecutiveDays;
}
// The densest possible packing under a rolling "at most maxShifts in any
// windowDays-day window" cap, over a span of `totalDays` — front-load
// each window-sized block, which is provably optimal for maximizing
// count under a rolling cap. Used as an upper-bound capacity estimate;
// an employee's real ceiling can only be lower (fewer available days).
export function maxShiftsUnderCap(shiftCap, totalDays) {
  if (!shiftCap || totalDays <= 0) return Infinity;
  const { windowDays, maxShifts } = shiftCap;
  return Math.floor(totalDays / windowDays) * maxShifts + Math.min(maxShifts, totalDays % windowDays);
}
// Local search doesn't keep a running per-employee stats object (each
// trial recomputes cost from scratch), so derive worked-day indices
// straight from the day array when it needs a cap check.
export function workedDayIndicesFromSchedule(daysArr, empId) {
  return daysArr.filter((d) => Object.values(d.assignment).some((a) => a.empId === empId)).map((d) => d.idx);
}

// For a standard employee, fixedDays is only a guaranteed minimum — they
// can still pick up extra shifts on other days via the general pool.
// For a capped (extended-hour) employee, fixedDays is exclusive: those
// are the only days they're scheduled at all, full stop. This checks
// the latter; it's a no-op (always eligible) for anyone without a cap,
// or a capped employee who hasn't set fixed days.
export function respectsFixedDayRestriction(emp, dowList) {
  if (!emp.shiftCap || emp.fixedDays.length === 0) return true;
  return dowList.every((dow) => emp.fixedDays.includes(dow));
}

// Whether an employee could possibly be assigned on a given day at all —
// the same base gate (PTO-1, fixed-day restriction) the real algorithm's
// pool/pool2 matching tiers use, before any per-shift preference logic.
// Ignores the employee's shift-cap window budget on purpose (see
// maxShiftsUnderCap for that, applied separately) — remaining budget
// depends on which OTHER days end up worked, a sequencing question this
// per-day check isn't meant to answer.
export function isEligibleForDay(emp, dow, ptoStatusForDay) {
  if (ptoStatusForDay === "PTO1") return false;
  return respectsFixedDayRestriction(emp, [dow]);
}

// Weekend rotation: a fixed calendar epoch (an actual Saturday) numbers
// every weekend in the world sequentially, so "weekend index" is stable
// no matter what rotation start date or length is currently in view —
// changing the visible window never reshuffles which weekends are whose
// turn. `emp.weekendRotation` is { cycleWeekends, openOffset } (the one
// weekend at `openOffset` within every `cycleWeekends`-weekend block is
// theirs to work; the rest are auto-blocked) or null to opt out of the
// rotation entirely (works every weekend, never auto-blocked).
export const WEEKEND_EPOCH = new Date("2024-01-06T00:00:00"); // a Saturday
export function saturdayOfWeekend(date) {
  const d = new Date(date);
  if (d.getDay() === 0) d.setDate(d.getDate() - 1); // Sunday -> its Saturday
  return d;
}
export function weekendIndexFor(date) {
  const sat = saturdayOfWeekend(date);
  const diffDays = Math.round((sat - WEEKEND_EPOCH) / 86400000);
  return Math.floor(diffDays / 7);
}
export function isOpenWeekend(rotation, weekendIndex) {
  if (!rotation) return true;
  const { cycleWeekends, openOffset } = rotation;
  const mod = ((weekendIndex % cycleWeekends) + cycleWeekends) % cycleWeekends;
  return mod === openOffset;
}

// Maximum bipartite matching via augmenting paths (Kuhn's algorithm).
export function kuhnMatch(slots, getCandidates) {
  const slotOf = {};
  const result = {};
  function tryFind(slot, visited) {
    for (const cand of getCandidates(slot)) {
      if (visited.has(cand)) continue;
      visited.add(cand);
      if (!(cand in slotOf) || tryFind(slotOf[cand], visited)) {
        slotOf[cand] = slot;
        result[slot] = cand;
        return true;
      }
    }
    return false;
  }
  for (const slot of slots) tryFind(slot, new Set());
  return result;
}

// Decomposes a run of `len` consecutive days into blocks each
// between minLen and maxLen, or returns null if impossible.
export function partitionRun(len, minLen, maxLen) {
  if (len <= 0) return [];
  const dp = new Array(len + 1).fill(false);
  const choice = new Array(len + 1).fill(0);
  dp[0] = true;
  for (let i = 1; i <= len; i++) {
    for (let b = minLen; b <= maxLen; b++) {
      if (i - b >= 0 && dp[i - b]) { dp[i] = true; choice[i] = b; break; }
    }
  }
  if (!dp[len]) return null;
  const blocks = [];
  let r = len;
  while (r > 0) { blocks.push(choice[r]); r -= choice[r]; }
  return blocks.reverse();
}
