import { describe, test, expect } from "vitest";
import { parseCsvText, buildAssignmentPlan } from "./scheduleImport";

describe("parseCsvText", () => {
  test("splits plain rows", () => {
    expect(parseCsvText("a,b,c\r\n1,2,3")).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
  });

  test("handles quoted fields with embedded commas and doubled quotes", () => {
    const text = 'Employee,Note\r\n"Smith, Jo","Said ""hi"" today"';
    expect(parseCsvText(text)).toEqual([
      ["Employee", "Note"],
      ["Smith, Jo", 'Said "hi" today'],
    ]);
  });

  test("ignores a trailing blank line", () => {
    expect(parseCsvText("a,b\r\n1,2\r\n")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

const day = (idx, wd, md) => ({ idx, wd, md, iso: `2024-01-${String(idx + 1).padStart(2, "0")}` });
const shiftDefs = [{ code: "E1", label: null }, { code: "E2", label: "Day" }];
const emp = (id, name, type = "permanent") => ({ id, name, type });

describe("buildAssignmentPlan", () => {
  const days = [day(0, "Mon", "1/1"), day(1, "Tue", "1/2")];
  const permanent = [emp(1, "Alice")];
  const extra = [emp(2, "Bob", "extra")];

  test("maps a shift code cell to an assignment", () => {
    const rows = [
      ["Employee", "Type", "Mon 1/1", "Tue 1/2"],
      ["Alice", "Permanent", "E1", ""],
    ];
    const plan = buildAssignmentPlan({ rows, days, permanent, extra, shiftDefsSorted: shiftDefs });
    expect(plan.assignmentsByDayIdx[0].E1).toEqual({ empId: 1, type: "permanent", override: false, fixed: false, manual: true });
    expect(plan.assignmentsByDayIdx[1]).toBeUndefined();
    expect(plan.matchedEmployeeCount).toBe(1);
  });

  test("resolves a custom shift label back to its code", () => {
    const rows = [["Employee", "Type", "Mon 1/1"], ["Alice", "Permanent", "Day"]];
    const plan = buildAssignmentPlan({ rows, days, permanent, extra, shiftDefsSorted: shiftDefs });
    expect(plan.assignmentsByDayIdx[0].E2.empId).toBe(1);
  });

  test("strips override/phantom decorations before matching", () => {
    const rows = [["Employee", "Type", "Mon 1/1"], ["Alice", "Permanent", "E1*"]];
    const plan = buildAssignmentPlan({ rows, days, permanent, extra, shiftDefsSorted: shiftDefs });
    expect(plan.assignmentsByDayIdx[0].E1.empId).toBe(1);
  });

  test("PTO-1/PTO-2/WKND cells become ptoUpdates, not assignments", () => {
    const rows = [
      ["Employee", "Type", "Mon 1/1", "Tue 1/2"],
      ["Alice", "Permanent", "PTO-1", "WKND"],
    ];
    const plan = buildAssignmentPlan({ rows, days, permanent, extra, shiftDefsSorted: shiftDefs });
    expect(plan.assignmentsByDayIdx).toEqual({});
    expect(plan.ptoUpdates).toEqual([
      { employee_id: 1, day_iso: "2024-01-01", status: "PTO1", source: "manual" },
      { employee_id: 1, day_iso: "2024-01-02", status: "PTO1", source: "weekend_rotation" },
    ]);
  });

  test("PTO-2 resolves to a PTO2 status", () => {
    const rows = [["Employee", "Type", "Mon 1/1"], ["Alice", "Permanent", "PTO-2"]];
    const plan = buildAssignmentPlan({ rows, days, permanent, extra, shiftDefsSorted: shiftDefs });
    expect(plan.ptoUpdates[0].status).toBe("PTO2");
  });

  test("an unmatched employee name is reported, not silently dropped", () => {
    const rows = [["Employee", "Type", "Mon 1/1"], ["Nobody Here", "Permanent", "E1"]];
    const plan = buildAssignmentPlan({ rows, days, permanent, extra, shiftDefsSorted: shiftDefs });
    expect(plan.unmatchedEmployeeNames).toEqual(["Nobody Here"]);
    expect(plan.matchedEmployeeCount).toBe(0);
  });

  test("an unmatched day column is reported and its cells ignored", () => {
    const rows = [["Employee", "Type", "Not A Real Day"], ["Alice", "Permanent", "E1"]];
    const plan = buildAssignmentPlan({ rows, days, permanent, extra, shiftDefsSorted: shiftDefs });
    expect(plan.unmatchedColumns).toEqual(["Not A Real Day"]);
    expect(plan.assignmentsByDayIdx).toEqual({});
  });

  test("an unrecognized shift code is flagged and left blank", () => {
    const rows = [["Employee", "Type", "Mon 1/1"], ["Alice", "Permanent", "ZZ"]];
    const plan = buildAssignmentPlan({ rows, days, permanent, extra, shiftDefsSorted: shiftDefs });
    expect(plan.unknownCodeCount).toBe(1);
    expect(plan.assignmentsByDayIdx).toEqual({});
    expect(plan.warnings[0]).toMatch(/ZZ/);
  });

  test("a double-booked shift keeps the first employee and flags the conflict", () => {
    const twoPermanent = [emp(1, "Alice"), emp(3, "Carol")];
    const rows = [
      ["Employee", "Type", "Mon 1/1"],
      ["Alice", "Permanent", "E1"],
      ["Carol", "Permanent", "E1"],
    ];
    const plan = buildAssignmentPlan({ rows, days, permanent: twoPermanent, extra, shiftDefsSorted: shiftDefs });
    expect(plan.assignmentsByDayIdx[0].E1.empId).toBe(1);
    expect(plan.warnings[0]).toMatch(/Alice.*Carol/);
  });

  test("the export's trailing 'Coverage gaps' row is skipped, not reported as an unmatched employee", () => {
    const rows = [
      ["Employee", "Type", "Mon 1/1"],
      ["Alice", "Permanent", "E1"],
      ["Coverage gaps", "", "E3"],
    ];
    const plan = buildAssignmentPlan({ rows, days, permanent, extra, shiftDefsSorted: shiftDefs });
    expect(plan.unmatchedEmployeeNames).toEqual([]);
    expect(plan.matchedEmployeeCount).toBe(1);
  });

  test("blank and OFF cells produce no assignment or PTO update", () => {
    const rows = [["Employee", "Type", "Mon 1/1", "Tue 1/2"], ["Alice", "Permanent", "", "OFF"]];
    const plan = buildAssignmentPlan({ rows, days, permanent, extra, shiftDefsSorted: shiftDefs });
    expect(plan.assignmentsByDayIdx).toEqual({});
    expect(plan.ptoUpdates).toEqual([]);
  });
});
