// Pre-generation capacity estimate: "does the current roster/PTO/rotation
// setup have any chance of covering this rotation?" — computed without
// actually running the matcher, using the SAME eligibility rules it uses
// (imported from schedulingCore, not re-derived here) so the numbers
// stay accurate as those rules evolve.
//
// This is a NECESSARY-condition check, not a full simulation: it can
// prove "you don't have enough capacity" with certainty, but a clean
// bill of health here doesn't guarantee zero holes — day-specific
// clustering (e.g. many people coincidentally off the same Tuesday) or
// shift-code-specific qualification gaps for PRN staff can still produce
// holes that only show up when you actually generate.

import { key, isEligibleForDay, maxShiftsUnderCap, weekendIndexFor } from "./schedulingCore";

export function buildFeasibilityReport({ days, permanent, extra, ptoStatus, extraAvailable, weekdayShifts, weekendShifts, holidays }) {
  // --- Overall aggregate: total shift-slots needed vs total capacity ---
  let requiredSlots = 0;
  days.forEach((d) => {
    const isWknd = d.isWeekend || holidays.has(d.iso);
    requiredSlots += isWknd ? weekendShifts.length : weekdayShifts.length;
  });

  let availablePermanentSlots = 0;
  permanent.forEach((emp) => {
    let availableDays = 0;
    days.forEach((d) => {
      if (isEligibleForDay(emp, d.dow, ptoStatus[key(emp.id, d.idx)])) availableDays++;
    });
    const ceiling = maxShiftsUnderCap(emp.shiftCap, days.length);
    availablePermanentSlots += Math.min(availableDays, ceiling);
  });

  let availablePrnSlots = 0;
  extra.forEach((emp) => {
    days.forEach((d) => { if (extraAvailable[key(emp.id, d.idx)]) availablePrnSlots++; });
  });

  const overall = {
    requiredSlots,
    availablePermanentSlots,
    availablePrnSlots,
    totalAvailable: availablePermanentSlots + availablePrnSlots,
    shortfall: Math.max(0, requiredSlots - availablePermanentSlots - availablePrnSlots),
  };

  // --- Weekend-by-weekend breakdown ---
  // Required PEOPLE (not shift-slots) for a weekend: the same person
  // covers their shift code on both Saturday and Sunday, so the people
  // needed equals the number of weekend shift codes, not double it.
  const weekends = [];
  for (let i = 0; i < days.length; i++) {
    const sat = days[i];
    if (sat.dow !== 6) continue;
    const sun = days[i + 1];
    if (!sun || sun.dow !== 0) continue;
    let availablePermanent = 0;
    permanent.forEach((emp) => {
      const satOk = isEligibleForDay(emp, sat.dow, ptoStatus[key(emp.id, sat.idx)]);
      const sunOk = isEligibleForDay(emp, sun.dow, ptoStatus[key(emp.id, sun.idx)]);
      if (satOk && sunOk) availablePermanent++;
    });
    const required = weekendShifts.length;
    weekends.push({
      weekendIndex: weekendIndexFor(sat.date),
      satIso: sat.iso, sunIso: sun.iso,
      satLabel: `${sat.wd} ${sat.md}`, sunLabel: `${sun.wd} ${sun.md}`,
      required, availablePermanent,
      shortfall: Math.max(0, required - availablePermanent),
    });
  }

  // --- Holiday-by-holiday breakdown ---
  const holidayList = [...holidays].filter((iso) => days.some((d) => d.iso === iso)).sort();
  const holidayReport = holidayList.map((iso) => {
    const d = days.find((dd) => dd.iso === iso);
    let availablePermanent = 0;
    permanent.forEach((emp) => { if (isEligibleForDay(emp, d.dow, ptoStatus[key(emp.id, d.idx)])) availablePermanent++; });
    let availablePrn = 0;
    extra.forEach((emp) => { if (extraAvailable[key(emp.id, d.idx)]) availablePrn++; });
    const required = weekendShifts.length;
    return {
      iso, label: `${d.wd} ${d.md}`,
      required, availablePermanent, availablePrn,
      shortfall: Math.max(0, required - availablePermanent - availablePrn),
    };
  });

  return { overall, weekends, holidays: holidayReport };
}
