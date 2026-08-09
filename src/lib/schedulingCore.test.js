import { describe, test, expect, vi, afterEach } from "vitest";
import {
  toLocalISO,
  nextMonday,
  fmtLabel,
  key,
  shiftPref,
  NEVER_WORKED_BONUS,
  wouldExceedShiftCap,
  longestConsecutiveRun,
  wouldExceedConsecutiveDays,
  maxShiftsUnderCap,
  workedDayIndicesFromSchedule,
  respectsFixedDayRestriction,
  isEligibleForDay,
  WEEKEND_EPOCH,
  weekendIndexFor,
  isOpenWeekend,
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
    // days 0,1,2 within a 14-day window, cap of 3 — adding a 4th 3 days later exceeds
    expect(wouldExceedShiftCap(cap(14, 3), [0, 1], [2])).toBe(false);
  });
  test("exceeding via only prior days is caught (construction-time shape)", () => {
    expect(wouldExceedShiftCap(cap(14, 1), [5], [15])).toBe(true); // 5 and 15 are 10 days apart, same 14-day window
  });
  test("exceeding via a LATER existing day is caught — the case a backward-only check would miss", () => {
    // existing day 20 comes AFTER the proposed day 15; a check that only looks
    // backward from 15 would see nothing and wrongly allow this. This is the
    // exact shape of bug once found in local search, which optimizes an
    // already-fully-built schedule where later days can already be assigned.
    expect(wouldExceedShiftCap(cap(14, 1), [20], [15])).toBe(true);
  });
  test("days far enough apart to never share a window do not exceed", () => {
    expect(wouldExceedShiftCap(cap(14, 1), [0], [20])).toBe(false);
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
