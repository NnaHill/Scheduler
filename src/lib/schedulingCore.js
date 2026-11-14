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
// The shift cap tracks real pay periods (e.g. 10 worked days every 14-day
// pay period) — fixed, non-overlapping calendar blocks, not a rolling
// "any 14 consecutive days" window. Two days 10 apart can land in
// different pay periods and shouldn't be treated as competing for the
// same quota just because they're within windowDays of each other; a
// rolling check also blocks real, payable shifts near a block boundary
// that a fixed pay period would have no problem with at all. Blocks are
// anchored to the schedule's own start date (day 0) — the same anchor
// weekend rotation groups use.
// The largest number of worked days found in any single pay-period block
// — the real "how loaded is this person's heaviest period" number, not
// just a yes/no over-the-line check. wouldExceedShiftCap below is just
// this compared against the cap; a live shift-count display can use this
// directly to show someone their actual current peak.
export function maxShiftsInAnyPayPeriod(workedDayIndices, windowDays) {
  const counts = {};
  workedDayIndices.forEach((idx) => {
    const block = Math.floor(idx / windowDays);
    counts[block] = (counts[block] || 0) + 1;
  });
  return Math.max(0, ...Object.values(counts));
}
export function wouldExceedShiftCap(emp, existingWorkedDayIndices, proposedDayIndices) {
  if (!emp.shiftCap) return false;
  const allDays = [...existingWorkedDayIndices, ...proposedDayIndices];
  return maxShiftsInAnyPayPeriod(allDays, emp.shiftCap.windowDays) > emp.shiftCap.maxShifts;
}

// The one reserved shift code that can have more than one person on it
// the same day — it exists purely to top someone up to their guaranteed
// shift count without inventing coverage nobody actually needs. Every
// extra person that day gets their own key (E0, E0#2, E0#3...) so the
// rest of the app's "one person per shift code per day" assumption never
// has to change; isOverflowKey/overflowBaseCode are the only two places
// that need to know the numbered keys all mean the same displayed shift.
export const OVERFLOW_CODE = "E0";
export function isOverflowKey(k) {
  return k === OVERFLOW_CODE || /^E0#\d+$/.test(k);
}
export function overflowBaseCode(k) {
  return isOverflowKey(k) ? OVERFLOW_CODE : k;
}
export function nextOverflowKey(dayAssignment) {
  if (!(OVERFLOW_CODE in dayAssignment)) return OVERFLOW_CODE;
  let n = 2;
  while (`${OVERFLOW_CODE}#${n}` in dayAssignment) n++;
  return `${OVERFLOW_CODE}#${n}`;
}

// A PRN entry on `dayIdx` this employee could take over: trained for
// it, and never a fixed or continuity commitment (displacing either
// would break a multi-day commitment the same way dragging onto it
// would). `onlyCodes`, if given, restricts the match to those codes.
// `getDay(dayIdx)` returns `{ assignment }` (a wider shape is fine —
// only `assignment` is read here).
function stealablePrnEntry(getDay, allowedShifts, isContinuityCode, dayIdx, onlyCodes) {
  const { assignment } = getDay(dayIdx);
  return Object.entries(assignment).find(([code, info]) => {
    const base = overflowBaseCode(code);
    return info.type === "extra" && !info.fixed && !isOverflowKey(code) && !isContinuityCode(base)
      && allowedShifts.includes(base) && (!onlyCodes || onlyCodes.includes(base));
  });
}

// Which day/cushion-code a phantom "needs manual coverage" flag should
// use, among a pay period's open candidate days, before falling back
// to anything more disruptive: first, a PRN already covering one of
// the manager's chosen "cushion" codes (e.g. a float role, usually
// lighter) — the easiest version of this shortfall to cover — and
// failing that, a cushion code nobody's using at all that day, claimed
// directly (never overwriting someone else's real shift, and never a
// code that isn't actually active that day — a weekday-only cushion
// code offered on a weekend/holiday, or vice versa, would otherwise
// look "open" simply because nobody needed it there in the first
// place). `getDay(dayIdx)` returns `{ assignment, activeShifts }`.
// Returns null when neither option exists anywhere in the block, or
// when no cushion codes are configured.
export function pickPhantomCushionSlot(candidateDayIndices, getDay, allowedShifts, cushionCodes, isContinuityCode) {
  if (!cushionCodes || !cushionCodes.length) return null;
  for (const dayIdx of candidateDayIndices) {
    const hit = stealablePrnEntry(getDay, allowedShifts, isContinuityCode, dayIdx, cushionCodes);
    if (hit) return { dayIdx, code: hit[0] };
  }
  for (const dayIdx of candidateDayIndices) {
    const { assignment, activeShifts } = getDay(dayIdx);
    const code = cushionCodes.find((c) => allowedShifts.includes(c) && !isContinuityCode(c) && !(c in assignment) && activeShifts.includes(c));
    if (code) return { dayIdx, code };
  }
  return null;
}

// Takes a manager's chosen cushion code from a PERMANENT employee for
// a phantom flag, when there's no PRN to take it from and no open
// slot to claim directly — but only when that employee can be handed
// something REAL in exchange on the exact same day: a genuine hole,
// or a PRN-covered shift they're trained for. Never a bare E0 filler,
// which would just move the same placeholder problem onto someone
// else instead of solving it, and never a fixed/continuity donor
// shift, same as everywhere else this would break a commitment.
// `getDay(dayIdx)` returns `{ assignment, holes }`; `getAllowedShifts`
// looks up a donor's training by empId. Returns `{ dayIdx, code,
// donorId, replacementCode }` for the caller to actually apply both
// halves of the swap, or null when no day in the block qualifies.
export function pickPhantomPermanentSwap(candidateDayIndices, getDay, allowedShifts, cushionCodes, excludeEmpId, getAllowedShifts, isContinuityCode) {
  if (!cushionCodes || !cushionCodes.length) return null;
  for (const dayIdx of candidateDayIndices) {
    const { assignment, holes } = getDay(dayIdx);
    for (const code of cushionCodes) {
      if (!allowedShifts.includes(code) || isContinuityCode(code)) continue;
      const entry = assignment[code];
      if (!entry || entry.type !== "permanent" || entry.fixed || entry.empId === excludeEmpId) continue;
      const donorAllowed = getAllowedShifts(entry.empId);
      if (!donorAllowed) continue;
      const holeCode = holes.find((hc) => donorAllowed.includes(hc) && !isContinuityCode(hc));
      const prnEntry = !holeCode && Object.entries(assignment).find(([c, info]) =>
        info.type === "extra" && !info.fixed && donorAllowed.includes(c) && !isContinuityCode(c));
      if (!holeCode && !prnEntry) continue;
      return { dayIdx, code, donorId: entry.empId, replacementCode: holeCode || prnEntry[0] };
    }
  }
  return null;
}

// Last resort before a plain E0 placeholder: take over ANY PRN's real
// shift, cushion or not — still real work beats inventing a
// placeholder on top of everything else. Same fixed/continuity
// exclusions as pickPhantomCushionSlot. `getDay(dayIdx)` returns
// `{ assignment }` — stealing an existing entry is always safe, since
// it was only ever placed there if it was actually active that day.
export function pickPhantomAnySteal(candidateDayIndices, getDay, allowedShifts, isContinuityCode) {
  for (const dayIdx of candidateDayIndices) {
    const hit = stealablePrnEntry(getDay, allowedShifts, isContinuityCode, dayIdx, null);
    if (hit) return { dayIdx, code: hit[0] };
  }
  return null;
}
// Which days to top up so an extended-hour employee actually reaches
// their guaranteed shift count for every pay period, not just stays under
// the ceiling. Pay periods are fixed, non-overlapping windowDays-long
// blocks anchored to the schedule's start date (see
// maxShiftsInAnyPayPeriod) — each block is topped up independently, so a
// shift already sitting in a neighboring period never blocks a pick here.
// Fills every eligible candidate day up to target, earliest first; picks
// can land several days in a row right after a gap (e.g. a PTO weekend)
// instead of staying spread through the block.
// isAcceptable(dayIdx, runningWorkedDayIndices), if given, is asked before
// each candidate is counted toward its block's quota — for a check like
// the consecutive-day hard limit, which depends on exactly which OTHER
// picks already landed nearby, not just static per-day eligibility. A day
// it rejects is skipped, not treated as using up the block's quota, so
// the fill keeps trying later candidates instead of falling short of
// target just because one specific day didn't work out.
export function pickOverflowDays(workedDayIndices, candidateIndices, totalDays, windowDays, target, isAcceptable) {
  const candidates = new Set(candidateIndices);
  const blockCounts = {};
  const runningWorked = [...workedDayIndices];
  workedDayIndices.forEach((idx) => {
    const block = Math.floor(idx / windowDays);
    blockCounts[block] = (blockCounts[block] || 0) + 1;
  });
  const picks = [];
  for (let i = 0; i < totalDays; i++) {
    if (!candidates.has(i)) continue;
    const block = Math.floor(i / windowDays);
    if ((blockCounts[block] || 0) >= target) continue;
    if (isAcceptable && !isAcceptable(i, runningWorked)) continue;
    runningWorked.push(i);
    blockCounts[block] = (blockCounts[block] || 0) + 1;
    picks.push(i);
  }
  return picks;
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
// Count "lonely" days off: a day the employee is free (not worked, not
// PTO-blocked) but both neighbouring calendar days are worked. These are
// the scattered single days off (Mon off, Tue–Thu on, Fri off) that a
// grouped-days-off preference wants to eliminate. Days off that already
// sit next to another day off, or next to the edge of the schedule, don't
// count — a 2+ day block is exactly what we want.
export function countLonelyDaysOff(workedDayIndices, freeDayIndices) {
  const worked = new Set(workedDayIndices);
  return freeDayIndices.filter((idx) => worked.has(idx - 1) && worked.has(idx + 1)).length;
}
// Count "lonely" shifts: a worked day with both neighbouring calendar days
// off (not worked). The flip side of countLonelyDaysOff — a lone workday
// between two days off. Days at the very start or end of the schedule
// don't count, same as lonely days off.
export function countLonelyShifts(workedDayIndices, totalDays) {
  const worked = new Set(workedDayIndices);
  return workedDayIndices.filter((idx) => idx > 0 && idx < totalDays - 1 && !worked.has(idx - 1) && !worked.has(idx + 1)).length;
}
// Count how many times an employee works the identical shift code on two
// consecutive calendar days — monotonous for staff, so it's discouraged.
// Two exceptions, same as the rest of the app: a Saturday->Sunday pair
// (the intentional weekend-pairing behavior) and a continuity-tagged code
// (built specifically to keep the same person on for several days).
// `dayEntries` is an ordered array of { dow, code } for one employee, one
// entry per calendar day in the schedule; `code` is falsy for a day not
// worked at all, which correctly breaks the adjacency (an off day in
// between means the two shifts aren't "back to back").
export function countBackToBackSameShift(dayEntries, isContinuityCode) {
  let count = 0;
  for (let i = 0; i < dayEntries.length - 1; i++) {
    const a = dayEntries[i], b = dayEntries[i + 1];
    if (!a.code || !b.code || a.code !== b.code) continue;
    if (isContinuityCode(a.code)) continue;
    if (a.dow === 6 && b.dow === 0) continue;
    count++;
  }
  return count;
}
// Shift codes on this day that nobody is assigned to. Derived from the
// assignment itself so it stays correct after the optimizer moves people.
export function unfilledShifts(day, activeShifts) {
  return activeShifts.filter((code) => !day.assignment[code]);
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

// Weekend rotation: weekends are numbered sequentially starting from the
// first weekend of the CURRENT schedule (see scheduleWeekendEpoch below),
// so "group 1 of N" always lines up with the first weekend of whatever
// period is currently being scheduled. `emp.weekendRotation` is
// { cycleWeekends, openOffset } (the one weekend at `openOffset` within
// every `cycleWeekends`-weekend block is theirs to work; the rest are
// auto-blocked) or null to opt out of the rotation entirely (works every
// weekend, never auto-blocked).
export const WEEKEND_EPOCH = new Date("2024-01-06T00:00:00"); // a Saturday — fallback epoch, mainly for tests
export function saturdayOfWeekend(date) {
  const d = new Date(date);
  if (d.getDay() === 0) d.setDate(d.getDate() - 1); // Sunday -> its Saturday
  return d;
}
// The Saturday of the first weekend inside `days` — this is weekend index
// 0 for the schedule currently being generated. Falls back to the first
// day if the window somehow contains no Saturday (e.g. a 1-day window).
export function scheduleWeekendEpoch(days) {
  const sat = days.find((d) => d.dow === 6);
  return sat ? sat.date : (days[0] ? days[0].date : WEEKEND_EPOCH);
}
export function weekendIndexFor(date, epoch = WEEKEND_EPOCH) {
  const sat = saturdayOfWeekend(date);
  const diffDays = Math.round((sat - epoch) / 86400000);
  return Math.floor(diffDays / 7);
}
export function isOpenWeekend(rotation, weekendIndex) {
  if (!rotation) return true;
  const { cycleWeekends, openOffset } = rotation;
  const mod = ((weekendIndex % cycleWeekends) + cycleWeekends) % cycleWeekends;
  return mod === openOffset;
}
// Whether a Friday or Monday sits right next to this employee's OFF
// weekend, per their rotation — the "extend off-weekends into a long
// weekend" preference uses this to softly discourage working that
// adjacent day. Any other day of the week, or no rotation at all, is
// always false. `epoch` is the same schedule-relative weekend epoch
// weekendIndexFor uses everywhere else.
export function isAdjacentToOffWeekend(rotation, date, dow, epoch) {
  if (!rotation) return false;
  const offsetDays = dow === 5 ? 1 : dow === 1 ? -2 : null; // Fri -> next Sat; Mon -> previous Sat
  if (offsetDays === null) return false;
  const satDate = new Date(date);
  satDate.setDate(satDate.getDate() + offsetDays);
  return !isOpenWeekend(rotation, weekendIndexFor(satDate, epoch));
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
