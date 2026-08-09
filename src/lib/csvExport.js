// Exports a generated schedule to CSV — one row per employee, one
// column per day. Mirrors the Schedule tab's cellFor logic exactly
// (shift code, "PTO-1"/"PTO-2", "OFF", or a trailing "*" for a PTO-2
// override) so the download always matches what's on screen.

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function cellForCsv(employee, day, ptoStatus, key, shiftLabelFn) {
  const entry = Object.entries(day.assignment).find(([, info]) => info.empId === employee.id);
  if (entry) return entry[1].override ? `${shiftLabelFn(entry[0])}*` : shiftLabelFn(entry[0]);
  const st = ptoStatus[key(employee.id, day.idx)];
  if (st === "PTO1") return "PTO-1";
  if (st === "PTO2") return "PTO-2";
  if (employee.type === "extra") return "";
  return "OFF";
}

export function buildScheduleCsv({ schedule, permanent, extra, ptoStatus, holidays, key, shiftLabel }) {
  const shiftLabelFn = shiftLabel || ((code) => code);
  const rows = [];
  rows.push(["Employee", "Type", ...schedule.days.map((d) => `${d.wd} ${d.md}${holidays.has(d.iso) ? " (HOL)" : ""}`)]);

  const addSection = (list, typeLabel) => {
    list.forEach((emp) => {
      rows.push([emp.name, typeLabel, ...schedule.days.map((d) => cellForCsv(emp, d, ptoStatus, key, shiftLabelFn))]);
    });
  };
  addSection(permanent, "Permanent");
  if (extra.length) addSection(extra, "PRN");

  rows.push(["Coverage gaps", "", ...schedule.days.map((d) => (d.holes.length > 0 ? d.holes.map(shiftLabelFn).join(" | ") : ""))]);

  return rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
}

export function downloadScheduleCsv(params, filename = "schedule.csv") {
  const csv = buildScheduleCsv(params);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
