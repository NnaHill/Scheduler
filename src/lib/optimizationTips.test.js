import { describe, test, expect } from "vitest";
import { buildOptimizationTips } from "./optimizationTips";

const label = (c) => c;
const settings = { maxConsecutiveDays: 6, consecutiveHardLimit: false, groupDaysOff: true, avoidLonelyShifts: true };
const day = (idx, extra = {}) => ({ idx, wd: "Mon", md: `${idx + 1}`, holes: [], isWknd: false, assignment: {}, ...extra });
const row = (extra = {}) => ({ name: "Ann", missingShifts: [], longestRun: 3, longestRunExceeded: false, lonelyDaysOff: 0, lonelyShifts: 0, ...extra });
const base = (extra = {}) => ({ schedule: { days: [day(0)], fairness: [row()], shiftCapViolations: [], cappedFixedDayViolations: [], continuityCheck: { violations: [] } }, feasibility: { byShift: [] }, employees: [], shiftLabel: label, settings, ...extra });

describe("buildOptimizationTips", () => {
  test("nothing wrong returns a single all-good tip", () => {
    const tips = buildOptimizationTips(base());
    expect(tips).toHaveLength(1);
    expect(tips[0].level).toBe("ok");
  });

  test("an unfilled shift produces a fix tip naming the shift and days", () => {
    const s = base();
    s.schedule.days = [day(0, { holes: ["COV1"] }), day(1, { holes: ["COV1"] })];
    const tips = buildOptimizationTips(s);
    expect(tips[0].id).toBe("hole-COV1");
    expect(tips[0].level).toBe("fix");
    expect(tips[0].title).toContain("COV1");
    expect(tips[0].title).toContain("2 days");
  });

  test("an empty shift explains what trained staff were doing instead", () => {
    const s = base({
      employees: [
        { id: 1, type: "permanent", allowedShifts: ["COV1"] },
        { id: 2, type: "permanent", allowedShifts: ["COV1"] },
        { id: 3, type: "permanent", allowedShifts: ["COV1"] },
      ],
      ptoStatus: { "1_0": "PTO1" },
    });
    s.schedule.days = [day(0, { holes: ["COV1"], assignment: { IV1: { empId: 2 } } })];
    const tip = buildOptimizationTips(s).find((t) => t.id === "hole-COV1");
    expect(tip.summary).toContain("3 permanent staff are trained on COV1");
    expect(tip.summary).toContain("1 on PTO");
    expect(tip.summary).toContain("1 working another shift");
    expect(tip.summary).toContain("1 free");
    expect(tip.steps.some((st) => st.change.includes("free but not used"))).toBe(true);
  });

  test("holes sort by how many days they affect, most first", () => {
    const s = base();
    s.schedule.days = [day(0, { holes: ["IV1"] }), day(1, { holes: ["COV2", "IV1"] }), day(2, { holes: ["IV1"] })];
    const ids = buildOptimizationTips(s).map((t) => t.id);
    expect(ids[0]).toBe("hole-IV1");
    expect(ids[1]).toBe("hole-COV2");
  });

  test("streak over the limit produces a fix tip", () => {
    const s = base();
    s.schedule.fairness = [row({ name: "Bo", longestRun: 9, longestRunExceeded: true })];
    const tip = buildOptimizationTips(s).find((t) => t.id === "streaks");
    expect(tip.level).toBe("fix");
    expect(tip.summary).toContain("Bo: 9 days");
  });

  test("lonely days and shifts are listed, and the unticked toggles get a step", () => {
    const s = base({ settings: { maxConsecutiveDays: 6, groupDaysOff: false, avoidLonelyShifts: true } });
    s.schedule.fairness = [row({ name: "Cy", lonelyDaysOff: 2, lonelyShifts: 1 })];
    const tip = buildOptimizationTips(s).find((t) => t.id === "lonely");
    expect(tip.summary).toContain("Cy: 2 lonely days off, 1 lonely shift");
    expect(tip.steps[0].change).toContain("Group days off together");
  });

  test("rotation groups with more than half the staff trigger a balance tip when weekends have holes", () => {
    const s = base();
    s.schedule.days = [day(5, { holes: ["COV1"], isWknd: true })];
    s.employees = [0, 0, 0, 1].map((g, i) => ({ id: i, type: "permanent", allowedShifts: [], weekendRotation: { cycleWeekends: 4, openOffset: g } }));
    const tip = buildOptimizationTips(s).find((t) => t.id === "weekend-groups");
    expect(tip).toBeDefined();
    expect(tip.summary).toContain("3 of 4");
  });

  test("hard limit with empty shifts suggests turning it off", () => {
    const s = base({ settings: { ...settings, consecutiveHardLimit: true } });
    s.schedule.days = [day(0, { holes: ["COV1"] })];
    const tip = buildOptimizationTips(s).find((t) => t.id === "settings-hard-limit");
    expect(tip).toBeDefined();
    expect(tip.steps[0].change).toContain("Untick");
  });

  test("hard limit off produces no hard-limit tip", () => {
    const s = base();
    s.schedule.days = [day(0, { holes: ["COV1"] })];
    expect(buildOptimizationTips(s).some((t) => t.id === "settings-hard-limit")).toBe(false);
  });

  test("turning off a grouping option gets a tip naming it", () => {
    const s = base({ settings: { ...settings, avoidLonelyShifts: false } });
    const tip = buildOptimizationTips(s).find((t) => t.id === "settings-grouping");
    expect(tip.summary).toContain("Avoid lonely shifts");
    expect(tip.summary).not.toContain("Group days off");
  });

  test("tips are ranked by how many empty shifts they could fill, with priority numbers", () => {
    const s = base({ settings: { ...settings, consecutiveHardLimit: true, avoidLonelyShifts: false } });
    s.schedule.days = [day(0, { holes: ["IV1"] }), day(1, { holes: ["IV1", "COV2"] }), day(2, { holes: ["IV1"] })];
    s.schedule.fairness = [row({ name: "Ann", longestRunExceeded: true, longestRun: 9 })];
    const tips = buildOptimizationTips(s);
    expect(tips[0].id).toBe("hole-IV1");
    expect(tips[0].priority).toBe(1);
    expect(tips[tips.length - 1].impact.count).toBe(0);
    expect(tips.map((t) => t.impact.count)).toEqual([...tips.map((t) => t.impact.count)].sort((a, b) => b - a));
  });

  test("violations from the matcher are surfaced as a fix tip", () => {
    const s = base();
    s.schedule.shiftCapViolations = ["Ann: 11 shifts within a 14-day span"];
    const tip = buildOptimizationTips(s).find((t) => t.id === "violations");
    expect(tip.level).toBe("fix");
  });
});
