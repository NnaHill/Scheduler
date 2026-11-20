// Parses an uploaded CSV/XLSX schedule file (same wide layout the app's
// own "Download CSV" button produces — one row per employee, one column
// per day) back into assignment data the Schedule tab can use. Pure,
// framework-free: App.jsx hands this the already-parsed rows (from
// Papa-free CSV parsing here, or from the xlsx library for spreadsheets)
// plus the current roster/shift list/day window, and gets back a plan
// the caller applies — this file never touches React state or Supabase.

// Minimal RFC4180 CSV parser — mirrors csvExport.js's own escaping
// (quote a field containing a comma/quote/newline, double up inner
// quotes) so a file this app exported comes back byte-for-byte.
export function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      pushField();
    } else if (c === "\r") {
      // swallow; \n (bare or following \r) ends the row
    } else if (c === "\n") {
      pushRow();
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

// A cell's text -> what it means. Tolerates the export's own decorations
// (a trailing "*" for a PTO-2 override, "!NEEDS COVERAGE" for a phantom
// guarantee-fill) by stripping them — on the way back in, a cell is just
// a plain assignment either way, not an override/phantom flag.
function stripDecorations(raw) {
  let s = raw.trim();
  const needsCoverage = /!NEEDS COVERAGE$/i;
  if (needsCoverage.test(s)) s = s.replace(needsCoverage, "").trim();
  else if (s.endsWith("*")) s = s.slice(0, -1).trim();
  return s;
}

function classifyCell(raw, labelToCode) {
  const s = stripDecorations(raw);
  if (s === "") return { kind: "blank" };
  const upper = s.toUpperCase();
  if (upper === "PTO-1" || upper === "PTO1") return { kind: "pto1" };
  if (upper === "PTO-2" || upper === "PTO2") return { kind: "pto2" };
  if (upper === "WKND") return { kind: "wknd" };
  if (upper === "OFF") return { kind: "off" };
  const code = labelToCode[s] || labelToCode[upper];
  if (code) return { kind: "shift", code };
  return { kind: "unknown", raw: s };
}

// `rows` is the full sheet as an array of arrays of strings: row 0 is the
// header (Employee, Type, <one column per day>...), every row after is
// one employee. `days` is the currently-configured rotation window
// (numWeeks/startDate) — a column only resolves to a day if its "Wd M/D"
// text matches one of these, so Setup needs to already cover the range
// being uploaded. `shiftDefsSorted` supplies the valid codes/labels.
export function buildAssignmentPlan({ rows, days, permanent, extra, shiftDefsSorted }) {
  const warnings = [];
  if (rows.length === 0) {
    return { assignmentsByDayIdx: {}, ptoUpdates: [], warnings: ["File is empty."], matchedEmployeeCount: 0, unmatchedEmployeeNames: [], unmatchedColumns: [], unknownCodeCount: 0 };
  }
  const labelToCode = {};
  shiftDefsSorted.forEach((d) => {
    labelToCode[d.code] = d.code;
    if (d.label) labelToCode[d.label] = d.code;
  });
  const validCodes = new Set(shiftDefsSorted.map((d) => d.code));

  const header = rows[0];
  const dayLabelToIdx = {};
  days.forEach((d) => { dayLabelToIdx[`${d.wd} ${d.md}`] = d.idx; });
  const unmatchedColumns = [];
  // column index (in a data row) -> day idx, or null if that column isn't a day column
  const columnDayIdx = header.map((cell, colIdx) => {
    if (colIdx < 2) return null; // "Employee", "Type"
    const cleaned = cell.trim().replace(/\s*\(HOL\)\s*$/i, "");
    const dayIdx = dayLabelToIdx[cleaned];
    if (dayIdx == null) { unmatchedColumns.push(cell); return null; }
    return dayIdx;
  });

  const employeesByName = new Map();
  [...permanent, ...extra].forEach((e) => {
    const k = e.name.trim().toLowerCase();
    if (!employeesByName.has(k)) employeesByName.set(k, e);
  });

  const assignmentsByDayIdx = {};
  const ptoUpdates = [];
  const unmatchedEmployeeNames = [];
  let matchedEmployeeCount = 0;
  let unknownCodeCount = 0;
  const dayByIdx = new Map(days.map((d) => [d.idx, d]));

  rows.slice(1).forEach((row) => {
    if (row.every((c) => c.trim() === "")) return; // blank trailing row
    const name = (row[0] || "").trim();
    if (!name) return;
    if (name === "Coverage gaps") return; // the export's own trailing summary row, not an employee
    const employee = employeesByName.get(name.toLowerCase());
    if (!employee) { unmatchedEmployeeNames.push(name); return; }
    matchedEmployeeCount++;

    columnDayIdx.forEach((dayIdx, colIdx) => {
      if (dayIdx == null) return;
      const raw = row[colIdx] ?? "";
      const cell = classifyCell(raw, labelToCode);
      const day = dayByIdx.get(dayIdx);
      if (cell.kind === "blank" || cell.kind === "off") return;
      if (cell.kind === "pto1" || cell.kind === "pto2" || cell.kind === "wknd") {
        ptoUpdates.push({
          employee_id: employee.id,
          day_iso: day.iso,
          status: "PTO1",
          source: cell.kind === "wknd" ? "weekend_rotation" : "manual",
          _status2: cell.kind === "pto2" ? "PTO2" : null, // resolved just below
        });
        return;
      }
      if (cell.kind === "unknown") {
        unknownCodeCount++;
        warnings.push(`Unrecognized value "${cell.raw}" for ${employee.name} on ${day.wd} ${day.md} — left blank.`);
        return;
      }
      // cell.kind === "shift"
      if (!validCodes.has(cell.code)) {
        unknownCodeCount++;
        warnings.push(`"${cell.code}" for ${employee.name} on ${day.wd} ${day.md} isn't one of this account's active shift codes — left blank.`);
        return;
      }
      if (!assignmentsByDayIdx[dayIdx]) assignmentsByDayIdx[dayIdx] = {};
      if (assignmentsByDayIdx[dayIdx][cell.code]) {
        const already = assignmentsByDayIdx[dayIdx][cell.code];
        const otherName = [...permanent, ...extra].find((e) => e.id === already.empId)?.name || "someone else";
        warnings.push(`${day.wd} ${day.md} ${cell.code}: both ${otherName} and ${employee.name} were assigned it — kept ${otherName}, skipped ${employee.name}.`);
        return;
      }
      assignmentsByDayIdx[dayIdx][cell.code] = { empId: employee.id, type: employee.type, override: false, fixed: false, manual: true };
    });
  });

  // Resolve the PTO2 marker set above into its real status value.
  const resolvedPtoUpdates = ptoUpdates.map(({ _status2, ...rest }) => (_status2 ? { ...rest, status: _status2 } : rest));

  return {
    assignmentsByDayIdx,
    ptoUpdates: resolvedPtoUpdates,
    warnings,
    matchedEmployeeCount,
    unmatchedEmployeeNames: [...new Set(unmatchedEmployeeNames)],
    unmatchedColumns,
    unknownCodeCount,
  };
}
