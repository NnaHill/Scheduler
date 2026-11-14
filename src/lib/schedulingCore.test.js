import { describe, test, expect, vi, afterEach } from "vitest";
import {
  toLocalISO,
  nextMonday,
  fmtLabel,
  key,
  shiftPref,
  NEVER_WORKED_BONUS,
  wouldExceedShiftCap,
  maxShiftsInAnyPayPeriod,
  isOverflowKey,
  overflowBaseCode,
  nextOverflowKey,
  pickOverflowDays,
  longestConsecutiveRun,
  wouldExceedConsecutiveDays,
  countLonelyDaysOff,
  countLonelyShifts,
  countBackToBackSameShift,
  unfilledShifts,
  maxShiftsUnderCap,
  workedDayIndicesFromSchedule,
  respectsFixedDayRestriction,
  isEligibleForDay,
  WEEKEND_EPOCH,
  weekendIndexFor,
  scheduleWeekendEpoch,
  isOpenWeekend,
  isAdjacentToOffWeekend,
  kuhnMatch,
  partitionRun,
} from "./schedulingCore";

describe("toLocalISO", () => {
  test("formats a date as YYYY-MM-DD with zero-padding", () => {
    expect(toLocalISO(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(toLocalISO(new Date(2026, 11, 25))).toBe("2026-12-25");
  });
});

describe("nextMonday", () => {
  afterEach(() => vi.useRealTimers());

  test("returns today when today is already Monday", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 10)); // 2026-08-10 is a Monday
    expect(nextMonday()).toBe("2026-08-10");
  });

  test("returns the coming Monday when today is midweek", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11)); // Tuesday
    expect(nextMonday()).toBe("2026-08-17");
  });

  test("returns tomorrow when today is Sunday", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 16)); // Sunday
    expect(nextMonday()).toBe("2026-08-17");
  });
});

describe("fmtLabel", () => {
  test("returns non-empty weekday and month/day strings", () => {
    const { wd, md } = fmtLabel(new Date(2026, 7, 10));
    expect(typeof wd).toBe("string");
    expect(wd.length).toBeGreaterThan(0);
    expect(typeof md).toBe("string");
    expect(md.length).toBeGreaterThan(0);
  });
});

describe("key", () => {
  test("joins id and day index with an underscore", () => {
    expect(key(5, 10)).toBe("5_10");
  });
});

describe("shiftPref", () => {
  test("applies the never-worked bonus when count is zero", () => {
    expect(shiftPref({ shiftCount: { E1: 0 } }, "E1")).toBe(NEVER_WORKED_BONUS);
  });
  test("returns the raw count once it's nonzero", () => {
    expect(shiftPref({ shiftCount: { E1: 3 } }, "E1")).toBe(3);
  });
  test("a never-worked candidate always sorts ahead of a worked one", () => {
    const never = shiftPref({ shiftCount: { E1: 0 } }, "E1");
    const worked = shiftPref({ shiftCount: { E1: 1 } }, "E1");
    expect(never).toBeLessThan(worked);
  });
});

describe("wouldExceedShiftCap", () => {
  const cap = (windowDays, maxShifts) => ({ shiftCap: { windowDays, maxShifts } });

  test("no cap set never exceeds", () => {
    expect(wouldExceedShiftCap({ shiftCap: null }, [1, 2, 3], [4])).toBe(false);
  });
  test("exactly at the cap does not exceed", () => {
    // days 0,1,2 all fall in the first 14-day pay period (block 0), cap of 3
    expect(wouldExceedShiftCap(cap(14, 3), [0, 1], [2])).toBe(false);
  });
  test("two days in the same fixed pay period count together regardless of order", () => {
    // days 14 and 20 both fall in block 1 (days 14-27) — it doesn't matter
    // which one is "existing" and which is "proposed".
    expect(wouldExceedShiftCap(cap(14, 1), [20], [14])).toBe(true);
    expect(wouldExceedShiftCap(cap(14, 1), [14], [20])).toBe(true);
  });
  test("days 10 apart but in different pay periods don't compete for the same quota", () => {
    // day 5 is in block 0 (days 0-13), day 15 is in block 1 (days 14-27) —
    // a rolling 14-day window would flag this, but they're different pay
    // periods, so this must NOT exceed.
    expect(wouldExceedShiftCap(cap(14, 1), [5], [15])).toBe(false);
  });
  test("days in different pay periods never exceed, no matter how close to a boundary", () => {
    expect(wouldExceedShiftCap(cap(14, 1), [13], [14])).toBe(false); // adjacent days, different blocks
  });
});

describe("maxShiftsInAnyPayPeriod", () => {
  test("no worked days has no peak", () => {
    expect(maxShiftsInAnyPayPeriod([], 14)).toBe(0);
  });
  test("three days clustered inside one pay period peak at 3", () => {
    expect(maxShiftsInAnyPayPeriod([0, 1, 2], 14)).toBe(3);
  });
  test("days spread across two separate pay periods peak at the denser one", () => {
    expect(maxShiftsInAnyPayPeriod([0, 1, 2, 30], 14)).toBe(3);
  });
  test("a fixed pay period, not a rolling window — adjacent days across a block boundary don't stack", () => {
    // day 13 is the last day of block 0, day 14 is the first day of block
    // 1 — they're one day apart but in different pay periods, so neither
    // block's count goes above 1.
    expect(maxShiftsInAnyPayPeriod([13, 14], 14)).toBe(1);
  });
});

describe("overflow shift (E0) helpers", () => {
  test("isOverflowKey recognizes the base code and every numbered slot", () => {
    expect(isOverflowKey("E0")).toBe(true);
    expect(isOverflowKey("E0#2")).toBe(true);
    expect(isOverflowKey("E0#17")).toBe(true);
    expect(isOverflowKey("E1")).toBe(false);
    expect(isOverflowKey("E01")).toBe(false);
  });
  test("overflowBaseCode normalizes any slot to the display code", () => {
    expect(overflowBaseCode("E0")).toBe("E0");
    expect(overflowBaseCode("E0#3")).toBe("E0");
    expect(overflowBaseCode("COV1")).toBe("COV1");
  });
  test("nextOverflowKey picks the base code first, then numbers upward", () => {
    expect(nextOverflowKey({})).toBe("E0");
    expect(nextOverflowKey({ E0: {} })).toBe("E0#2");
    expect(nextOverflowKey({ E0: {}, "E0#2": {} })).toBe("E0#3");
    expect(nextOverflowKey({ E0: {}, "E0#3": {} })).toBe("E0#2"); // fills the gap
  });
});

describe("pickOverflowDays", () => {
  test("no shortfall picks nothing", () => {
    expect(pickOverflowDays([0, 1, 2], [3, 4, 5], 14, 14, 3)).toEqual([]);
  });
  test("a shortfall of one picks exactly one candidate day", () => {
    expect(pickOverflowDays([0, 1], [2, 3, 4], 14, 14, 3)).toEqual([2]);
  });
  test("no eligible candidate days means no picks, even with a shortfall", () => {
    expect(pickOverflowDays([0], [], 14, 14, 3)).toEqual([]);
  });
  test("each non-overlapping block is topped up independently", () => {
    // Block 1 (days 0-13) is already full; block 2 (days 14-27) needs
    // exactly as many candidates as the shortfall, so all of them are used.
    const worked = [0, 1, 2];
    const candidates = [14, 15, 16];
    expect(pickOverflowDays(worked, candidates, 28, 14, 3)).toEqual([14, 15, 16]);
  });
  test("fills as early as possible, reaching the target in one run", () => {
    const picks = pickOverflowDays([], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 14, 14, 3);
    expect(picks).toEqual([0, 1, 2]);
  });
  test("a gap of ineligible days (e.g. PTO) is recovered right after it, not split evenly", () => {
    // Days 0-1 are off (not candidates); reaching target 10 in a 14-day
    // window means working every remaining day, back to back.
    const candidates = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
    expect(pickOverflowDays([], candidates, 14, 14, 10)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
  test("reaches the full target in every fixed pay period, even with a forced gap in one of them", () => {
    // Off-weekend PTO lands in two different pay periods (days 5-6 in
    // block 0, days 33-34 in block 2) but each period is topped up
    // independently, so every one of the 4 periods still hits its own 10.
    const totalDays = 56, windowDays = 14, target = 10;
    const pto1 = new Set([5, 6, 33, 34]);
    const candidates = [];
    for (let i = 0; i < totalDays; i++) if (!pto1.has(i)) candidates.push(i);
    const picks = pickOverflowDays([], candidates, totalDays, windowDays, target);
    expect(picks).toHaveLength(40);
    expect(maxShiftsInAnyPayPeriod(picks, windowDays)).toBe(target);
  });
  test("rejects a pick once its pay period is already full, even from days worked elsewhere in it", () => {
    // Days 18-27 are already worked (10 of them, all in block 1 / days
    // 14-27 — that period is already full). Days 16 and 17 fall in the
    // same block, so they're rejected regardless of where in the block
    // the existing work came from.
    const worked = [18, 19, 20, 21, 22, 23, 24, 25, 26, 27];
    const picks = pickOverflowDays(worked, [16, 17], 28, 14, 10);
    expect(picks).toEqual([]);
  });
  test("when isAcceptable rejects a candidate, it keeps trying later ones instead of giving up on the block", () => {
    // Days 0,1,2 are worked; days 5,6,7 are worked. Candidates 3,4,9 could
    // close the gap to reach a target of 10, but accepting BOTH 3 and 4
    // would bridge 0-7 into an 8-day run, over a 6-day limit. A predicate
    // that rejects day 4 for that reason shouldn't stop the fill short —
    // it should fall through to day 9 and still hit target.
    const worked = [0, 1, 2, 5, 6, 7, 10, 11];
    const isAcceptable = (idx, running) => {
      const test = [...running, idx].sort((a, b) => a - b);
      let longest = 1, cur = 1;
      for (let i = 1; i < test.length; i++) {
        cur = test[i] === test[i - 1] + 1 ? cur + 1 : 1;
        longest = Math.max(longest, cur);
      }
      return longest <= 6;
    };
    const picks = pickOverflowDays(worked, [3, 4, 9], 56, 14, 10, isAcceptable);
    expect(picks).toEqual([3, 9]); // 4 skipped (would make an 8-day run), 9 used instead
    expect(worked.length + picks.length).toBe(10); // target still reached
  });
});

describe("longestConsecutiveRun", () => {
  test("empty input has no run", () => {
    expect(longestConsecutiveRun([])).toBe(0);
  });
  test("a single day is a run of 1", () => {
    expect(longestConsecutiveRun([5])).toBe(1);
  });
  test("consecutive indices form one run", () => {
    expect(longestConsecutiveRun([3, 4, 5, 6])).toBe(4);
  });
  test("a gap splits into separate runs, longest wins", () => {
    expect(longestConsecutiveRun([0, 1, 2, 10, 11])).toBe(3);
  });
  test("unordered, duplicated input is handled the same as sorted unique input", () => {
    expect(longestConsecutiveRun([6, 4, 5, 4, 3])).toBe(4);
  });
});

describe("wouldExceedConsecutiveDays", () => {
  test("no max set never exceeds", () => {
    expect(wouldExceedConsecutiveDays([1, 2, 3], [4], 0)).toBe(false);
    expect(wouldExceedConsecutiveDays([1, 2, 3], [4], null)).toBe(false);
  });
  test("staying at or under the max does not exceed", () => {
    expect(wouldExceedConsecutiveDays([0, 1, 2, 3], [4], 5)).toBe(false);
  });
  test("crossing over the max is caught", () => {
    expect(wouldExceedConsecutiveDays([0, 1, 2, 3, 4], [5], 5)).toBe(true);
  });
  test("existing days alone already over the max is caught even without a proposed day bridging anything new", () => {
    expect(wouldExceedConsecutiveDays([0, 1, 2, 3, 4, 5, 6], [], 6)).toBe(true);
  });
  test("a proposed day that doesn't connect to the existing run is fine", () => {
    expect(wouldExceedConsecutiveDays([0, 1, 2, 3, 4], [20], 6)).toBe(false);
  });
});

describe("countLonelyDaysOff", () => {
  test("a single free day between two worked days is lonely", () => {
    expect(countLonelyDaysOff([0, 2], [1])).toBe(1);
  });
  test("a free block of two or more is not lonely", () => {
    expect(countLonelyDaysOff([0, 3], [1, 2])).toBe(0);
  });
  test("a free day at the edge of the schedule is not lonely", () => {
    expect(countLonelyDaysOff([1], [0])).toBe(0);
  });
  test("alternating work and off days makes every off day lonely", () => {
    expect(countLonelyDaysOff([0, 2, 4, 6], [1, 3, 5])).toBe(3);
  });
  test("grouped off days (5 on, 2 off) produce no lonely days", () => {
    expect(countLonelyDaysOff([0, 1, 2, 3, 4, 7, 8, 9, 10, 11], [5, 6, 12, 13])).toBe(0);
  });
});

describe("countLonelyShifts", () => {
  test("a lone workday between two days off is lonely", () => {
    expect(countLonelyShifts([2], 5)).toBe(1);
  });
  test("a workday next to another workday is not lonely", () => {
    expect(countLonelyShifts([2, 3], 6)).toBe(0);
  });
  test("a workday at the start or end of the schedule is not lonely", () => {
    expect(countLonelyShifts([0, 4], 5)).toBe(0);
  });
  test("alternating work and off makes every workday lonely", () => {
    expect(countLonelyShifts([1, 3, 5], 7)).toBe(3);
  });
});

describe("countBackToBackSameShift", () => {
  const dow = (idx) => idx % 7; // schedule starting on a Sunday for easy math: idx 6/7 = Sat/Sun
  const day = (idx, code) => ({ dow: dow(idx), code });

  test("the same code two weekdays running counts once", () => {
    const entries = [day(1, "E1"), day(2, "E1"), day(3, "E2")];
    expect(countBackToBackSameShift(entries, () => false)).toBe(1);
  });
  test("three in a row counts two adjacent pairs", () => {
    const entries = [day(1, "E1"), day(2, "E1"), day(3, "E1")];
    expect(countBackToBackSameShift(entries, () => false)).toBe(2);
  });
  test("different codes on consecutive days don't count", () => {
    const entries = [day(1, "E1"), day(2, "E2")];
    expect(countBackToBackSameShift(entries, () => false)).toBe(0);
  });
  test("an off day in between breaks the adjacency", () => {
    const entries = [day(1, "E1"), day(2, null), day(3, "E1")];
    expect(countBackToBackSameShift(entries, () => false)).toBe(0);
  });
  test("a Saturday->Sunday repeat is exempt (weekend pairing)", () => {
    const entries = [day(6, "E1"), day(7, "E1")]; // dow 6 = Sat, dow 0 (7%7) = Sun
    expect(countBackToBackSameShift(entries, () => false)).toBe(0);
  });
  test("a Sunday->Monday repeat is NOT exempt", () => {
    const entries = [day(7, "E1"), day(8, "E1")]; // dow 0 = Sun, dow 1 = Mon
    expect(countBackToBackSameShift(entries, () => false)).toBe(1);
  });
  test("a continuity-tagged code is exempt even on weekdays", () => {
    const entries = [day(1, "CONT"), day(2, "CONT")];
    expect(countBackToBackSameShift(entries, (code) => code === "CONT")).toBe(0);
  });
});

describe("unfilledShifts", () => {
  test("lists active shifts with nobody assigned", () => {
    const day = { assignment: { E1: { empId: 1 }, E3: { empId: 2 } } };
    expect(unfilledShifts(day, ["E1", "E2", "E3"])).toEqual(["E2"]);
  });
  test("a fully staffed day has no unfilled shifts", () => {
    const day = { assignment: { E1: { empId: 1 } } };
    expect(unfilledShifts(day, ["E1"])).toEqual([]);
  });
});

describe("maxShiftsUnderCap", () => {
  test("no cap means unlimited", () => {
    expect(maxShiftsUnderCap(null, 20)).toBe(Infinity);
  });
  test("zero or negative span means unlimited (nothing to pack)", () => {
    expect(maxShiftsUnderCap({ windowDays: 14, maxShifts: 7 }, 0)).toBe(Infinity);
  });
  test("a span exactly one window wide caps at maxShifts", () => {
    expect(maxShiftsUnderCap({ windowDays: 14, maxShifts: 7 }, 14)).toBe(7);
  });
  test("a span of exactly two windows doubles it", () => {
    expect(maxShiftsUnderCap({ windowDays: 14, maxShifts: 7 }, 28)).toBe(14);
  });
  test("a partial trailing window adds its own capped remainder", () => {
    // floor(20/14)=1 full window (7) + min(7, 20%14=6) = 6 -> 13
    expect(maxShiftsUnderCap({ windowDays: 14, maxShifts: 7 }, 20)).toBe(13);
  });
});

describe("workedDayIndicesFromSchedule", () => {
  const daysArr = [
    { idx: 0, assignment: { E1: { empId: 1 } } },
    { idx: 1, assignment: { E2: { empId: 2 } } },
    { idx: 2, assignment: { E1: { empId: 1 }, E2: { empId: 3 } } },
  ];
  test("returns every day index where the employee has any assignment", () => {
    expect(workedDayIndicesFromSchedule(daysArr, 1)).toEqual([0, 2]);
  });
  test("returns an empty array for an employee who never worked", () => {
    expect(workedDayIndicesFromSchedule(daysArr, 99)).toEqual([]);
  });
});

describe("respectsFixedDayRestriction", () => {
  test("no shift cap means no restriction, regardless of fixed days", () => {
    expect(respectsFixedDayRestriction({ shiftCap: null, fixedDays: [1, 2, 3] }, [0])).toBe(true);
  });
  test("capped but no fixed days set means no restriction", () => {
    expect(respectsFixedDayRestriction({ shiftCap: {}, fixedDays: [] }, [0])).toBe(true);
  });
  test("capped with fixed days: eligible on a fixed day", () => {
    expect(respectsFixedDayRestriction({ shiftCap: {}, fixedDays: [1, 2, 3] }, [1])).toBe(true);
  });
  test("capped with fixed days: NOT eligible on a non-fixed day", () => {
    expect(respectsFixedDayRestriction({ shiftCap: {}, fixedDays: [1, 2, 3] }, [0])).toBe(false);
  });
  test("a multi-day block is only eligible if every day is a fixed day", () => {
    expect(respectsFixedDayRestriction({ shiftCap: {}, fixedDays: [1, 2, 3] }, [1, 2])).toBe(true);
    expect(respectsFixedDayRestriction({ shiftCap: {}, fixedDays: [1, 2, 3] }, [1, 0])).toBe(false);
  });
});

describe("isEligibleForDay", () => {
  const standard = { shiftCap: null, fixedDays: [] };
  test("PTO-1 always makes a day ineligible", () => {
    expect(isEligibleForDay(standard, 3, "PTO1")).toBe(false);
  });
  test("PTO-2 or no PTO status is eligible for a standard employee", () => {
    expect(isEligibleForDay(standard, 3, "PTO2")).toBe(true);
    expect(isEligibleForDay(standard, 3, undefined)).toBe(true);
  });
  test("a capped employee is ineligible on a non-fixed day even with no PTO", () => {
    const capped = { shiftCap: {}, fixedDays: [1, 2, 3] };
    expect(isEligibleForDay(capped, 0, undefined)).toBe(false);
    expect(isEligibleForDay(capped, 1, undefined)).toBe(true);
  });
});

describe("weekendIndexFor / saturdayOfWeekend", () => {
  test("the epoch Saturday itself is weekend index 0", () => {
    expect(weekendIndexFor(WEEKEND_EPOCH)).toBe(0);
  });
  test("the Sunday right after the epoch Saturday shares its index", () => {
    expect(weekendIndexFor(new Date("2024-01-07T00:00:00"))).toBe(0);
  });
  test("each following Saturday increments the index by one", () => {
    expect(weekendIndexFor(new Date("2024-01-13T00:00:00"))).toBe(1);
    expect(weekendIndexFor(new Date("2024-01-20T00:00:00"))).toBe(2);
  });
  test("an explicit epoch overrides the default", () => {
    const epoch = new Date("2026-12-05T00:00:00"); // a Saturday
    expect(weekendIndexFor(epoch, epoch)).toBe(0);
    expect(weekendIndexFor(new Date("2026-12-12T00:00:00"), epoch)).toBe(1);
  });
});

describe("scheduleWeekendEpoch", () => {
  test("picks the first Saturday in the days array, regardless of start date", () => {
    // A schedule starting on a Monday: Sat is 5 days in.
    const days = Array.from({ length: 14 }, (_, idx) => {
      const date = new Date("2026-11-16T00:00:00");
      date.setDate(date.getDate() + idx);
      return { idx, date, dow: date.getDay() };
    });
    const epoch = scheduleWeekendEpoch(days);
    expect(epoch.toISOString().slice(0, 10)).toBe("2026-11-21");
    // So that same Saturday is weekend index 0 for this schedule.
    expect(weekendIndexFor(epoch, epoch)).toBe(0);
  });
});

describe("isOpenWeekend", () => {
  test("no rotation means always open", () => {
    expect(isOpenWeekend(null, 5)).toBe(true);
  });
  test("open only on the matching phase of the cycle", () => {
    const rotation = { cycleWeekends: 4, openOffset: 0 };
    expect(isOpenWeekend(rotation, 0)).toBe(true);
    expect(isOpenWeekend(rotation, 4)).toBe(true); // next full cycle
    expect(isOpenWeekend(rotation, 1)).toBe(false);
    expect(isOpenWeekend(rotation, 2)).toBe(false);
  });
  test("a nonzero offset picks a different phase", () => {
    expect(isOpenWeekend({ cycleWeekends: 4, openOffset: 2 }, 2)).toBe(true);
    expect(isOpenWeekend({ cycleWeekends: 4, openOffset: 2 }, 0)).toBe(false);
  });
  test("negative weekend indices still resolve correctly (modulo safety)", () => {
    expect(isOpenWeekend({ cycleWeekends: 4, openOffset: 3 }, -1)).toBe(true);
    expect(isOpenWeekend({ cycleWeekends: 4, openOffset: 0 }, -1)).toBe(false);
  });
});

describe("isAdjacentToOffWeekend", () => {
  // Every-other-weekend rotation with openOffset 1, checked against
  // WEEKEND_EPOCH (2024-01-06, a Saturday) — so weekend index 0
  // (1/6-1/7) is their OFF weekend, and index 1 (1/13-1/14) is their ON
  // weekend.
  const rotation = { cycleWeekends: 2, openOffset: 1 };

  test("the Friday right before an OFF weekend counts", () => {
    expect(isAdjacentToOffWeekend(rotation, new Date("2024-01-05T00:00:00"), 5, WEEKEND_EPOCH)).toBe(true);
  });
  test("the Monday right after an OFF weekend counts", () => {
    expect(isAdjacentToOffWeekend(rotation, new Date("2024-01-08T00:00:00"), 1, WEEKEND_EPOCH)).toBe(true);
  });
  test("the Friday before a working weekend does not count", () => {
    expect(isAdjacentToOffWeekend(rotation, new Date("2024-01-12T00:00:00"), 5, WEEKEND_EPOCH)).toBe(false);
  });
  test("a day that isn't Friday or Monday never counts", () => {
    expect(isAdjacentToOffWeekend(rotation, new Date("2024-01-03T00:00:00"), 3, WEEKEND_EPOCH)).toBe(false);
  });
  test("no rotation never counts", () => {
    expect(isAdjacentToOffWeekend(null, new Date("2024-01-05T00:00:00"), 5, WEEKEND_EPOCH)).toBe(false);
  });
});

describe("kuhnMatch", () => {
  test("matches a simple one-to-one case", () => {
    const candidates = { A: ["x"], B: ["y"] };
    const result = kuhnMatch(["A", "B"], (slot) => candidates[slot]);
    expect(result).toEqual({ A: "x", B: "y" });
  });
  test("leaves a slot unmatched when it has no candidates", () => {
    const candidates = { A: ["x"], B: [] };
    const result = kuhnMatch(["A", "B"], (slot) => candidates[slot]);
    expect(result.A).toBe("x");
    expect(result.B).toBeUndefined();
  });
  test("finds the maximum matching via an augmenting path, not just greedy first-come", () => {
    // x is the ONLY candidate for B, but also a candidate for A alongside y.
    // A greedy pass processing A first would grab x for A and leave B
    // unmatched. The correct maximum matching re-routes x to B and gives A
    // to y instead, matching both slots.
    const candidates = { A: ["x", "y"], B: ["x"] };
    const result = kuhnMatch(["A", "B"], (slot) => candidates[slot]);
    expect(result.B).toBe("x");
    expect(result.A).toBe("y");
  });
});

describe("partitionRun", () => {
  test("a zero-length run needs no blocks", () => {
    expect(partitionRun(0, 2, 3)).toEqual([]);
  });
  test("an impossible length (too short for the minimum block) returns null", () => {
    expect(partitionRun(1, 2, 3)).toBeNull();
  });
  test("a decomposable length returns blocks that sum to it and each fall in range", () => {
    for (const len of [4, 5, 6, 7, 8, 10]) {
      const blocks = partitionRun(len, 2, 3);
      expect(blocks).not.toBeNull();
      expect(blocks.reduce((a, b) => a + b, 0)).toBe(len);
      blocks.forEach((b) => {
        expect(b).toBeGreaterThanOrEqual(2);
        expect(b).toBeLessThanOrEqual(3);
      });
    }
  });
});
