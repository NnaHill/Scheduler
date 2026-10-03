// Turns the most recently generated schedule into a short, ordered list of
// fixes. Pure: everything comes in as arguments, so the rules are easy to
// test and easy to extend — add a new check as one more block below.

const MAX_LISTED = 3;

function dayLabel(d) {
  return `${d.wd} ${d.md}`;
}

function listDays(days, max = 4) {
  const shown = days.slice(0, max).join(", ");
  return days.length > max ? `${shown} +${days.length - max} more` : shown;
}

export function buildOptimizationTips({ schedule, feasibility, employees, ptoStatus, shiftLabel, settings }) {
  const tips = [];
  const label = (code) => shiftLabel(code);
  const rows = schedule.fairness || [];

  // 1. Unfilled shifts, grouped by shift code. For each empty day, look at
  // the permanent staff trained on that shift and say what they were doing
  // instead — that tells the manager which fix actually applies.
  const holeDaysByCode = {};
  const holeDayObjsByCode = {};
  schedule.days.forEach((d) => d.holes.forEach((code) => {
    if (!holeDaysByCode[code]) { holeDaysByCode[code] = []; holeDayObjsByCode[code] = []; }
    holeDaysByCode[code].push(dayLabel(d));
    holeDayObjsByCode[code].push(d);
  }));
  const holeCodes = Object.keys(holeDaysByCode).sort((a, b) => holeDaysByCode[b].length - holeDaysByCode[a].length);
  holeCodes.slice(0, MAX_LISTED).forEach((code) => {
    const days = holeDaysByCode[code];
    const short = (feasibility?.byShift || []).find((s) => s.code === code);
    const trained = (employees || []).filter((e) => e.type === "permanent" && e.allowedShifts.includes(code));
    let onPto = 0, workingOther = 0, freeUnused = 0;
    holeDayObjsByCode[code].forEach((d) => {
      const workingIds = new Set(Object.values(d.assignment).map((a) => a.empId));
      trained.forEach((e) => {
        const st = ptoStatus ? ptoStatus[`${e.id}_${d.idx}`] : undefined;
        if (workingIds.has(e.id)) workingOther++;
        else if (st === "PTO1" || st === "PTO2") onPto++;
        else freeUnused++;
      });
    });
    const breakdown = `${trained.length} permanent staff are trained on ${label(code)}. Across the ${days.length} empty day${days.length === 1 ? "" : "s"}, they were: ${onPto} on PTO, ${workingOther} working another shift, and ${freeUnused} free (counted per person per day).`;
    const steps = [];
    if (short && short.shortfall > 0) {
      steps.push({ where: "3. Permanent Staff", change: `Not enough people are trained on "${label(code)}" overall. Tick "${label(code)}" under "Trained on" for more people who can cover it.` });
    }
    if (freeUnused > 0) {
      steps.push({ where: "3. Permanent Staff", change: `${freeUnused} trained person-day${freeUnused === 1 ? " was" : "s were"} free but not used. Check their shift caps (extended-hour settings) and fixed days, then Generate again.` });
    }
    if (onPto > 0) {
      steps.push({ where: "3. Permanent Staff → PTO grid", change: "Clear any PTO-2 (amber) marks on the empty days if they're not firm, so trained staff can be scheduled." });
    }
    steps.push({ where: "4. PRN Staff", change: `Add a backup person trained on "${label(code)}" to cover these days.` });
    steps.push({ where: "2. Setup", change: "Compare with the Feasibility check's \"Short on staff trained for a specific shift\" table to confirm." });
    tips.push({
      id: `hole-${code}`,
      level: "fix",
      impact: { count: days.length, text: `Could fill up to ${days.length} empty shift${days.length === 1 ? "" : "s"}` },
      title: `Shift ${label(code)} is empty on ${days.length} day${days.length === 1 ? "" : "s"}`,
      summary: `Days: ${listDays(days)}. ${breakdown}`,
      steps,
    });
  });

  // 1b. Settings that can leave shifts empty or make scheduling tighter.
  const totalEmpty = schedule.days.reduce((sum, d) => sum + d.holes.length, 0);
  if (totalEmpty > 0 && settings.consecutiveHardLimit) {
    tips.push({
      id: "settings-hard-limit",
      level: "tip",
      impact: { count: 0, text: "Didn't change the number of empty shifts when we tested it" },
      title: "The Hard limit on consecutive days may be leaving shifts empty",
      summary: `With Hard limit on, nobody can go over ${settings.maxConsecutiveDays} days in a row, even if that leaves a shift empty.`,
      steps: [
        { where: "2. Setup", change: "Untick \"Hard limit\" next to Max consecutive days. The limit becomes a preference, so shifts can get filled." },
        { where: "2. Setup", change: "Click Generate schedule and compare the number of empty shifts." },
        { where: "2. Setup", change: `If you keep Hard limit on, raising Max consecutive days from ${settings.maxConsecutiveDays} to 7 gives the scheduler more room.` },
      ],
    });
  }
  if (!settings.groupDaysOff || !settings.avoidLonelyShifts) {
    const off = [!settings.groupDaysOff && "Group days off together", !settings.avoidLonelyShifts && "Avoid lonely shifts"].filter(Boolean);
    tips.push({
      id: "settings-grouping",
      level: "tip",
      impact: { count: 0, text: "Doesn't change empty shifts (tidies the week instead)" },
      title: `Turn on ${off.length === 1 ? "this option" : "these options"} to tidy the week`,
      summary: `Currently off: ${off.join(" and ")}. Turning ${off.length === 1 ? "it" : "them"} on can cut scattered days off and single shifts. It doesn't change how many shifts are empty.`,
      steps: [
        { where: "2. Setup", change: `Tick ${off.map((o) => `"${o}"`).join(" and ")} under Days off.` },
        { where: "2. Setup", change: "Click Generate schedule and check the Lonely columns in the Fairness Report." },
      ],
    });
  }

  // 2. Weekend holes and rotation groups bunched together.
  const weekendHoles = schedule.days.filter((d) => d.isWknd && d.holes.length > 0).length;
  const rotated = (employees || []).filter((e) => e.type === "permanent" && e.weekendRotation && e.weekendRotation.cycleWeekends > 1);
  if (weekendHoles > 0 && rotated.length >= 3) {
    const byGroup = {};
    rotated.forEach((e) => { byGroup[e.weekendRotation.openOffset] = (byGroup[e.weekendRotation.openOffset] || 0) + 1; });
    const [biggestGroup, biggestCount] = Object.entries(byGroup).sort((a, b) => b[1] - a[1])[0];
    if (biggestCount * 2 > rotated.length) {
      tips.push({
        id: "weekend-groups",
        level: "fix",
        impact: { count: weekendHoles, text: `Could help some of the ${weekendHoles} empty weekend shift(s) — not yet tested` },
        title: "Too many people are on the same weekend rotation group",
        summary: `${biggestCount} of ${rotated.length} rotated staff share group ${Number(biggestGroup) + 1}, so those weekends run thin.`,
        steps: [
          { where: "3. Permanent Staff", change: "Find the \"group\" dropdown on each rotated person's row." },
          { where: "3. Permanent Staff", change: `Move some people from group ${Number(biggestGroup) + 1} to a different group so weekends are covered evenly.` },
          { where: "3. Permanent Staff", change: "Click \"Apply weekend rotation\" again after changing groups." },
        ],
      });
    }
  }

  // 3. Staff who never worked one of their trained shifts.
  const missing = rows.filter((f) => f.missingShifts && f.missingShifts.length > 0);
  if (missing.length > 0) {
    tips.push({
      id: "missing-shifts",
      level: "tip",
      impact: { count: 0, text: "Doesn't fill empty shifts directly" },
      title: `${missing.length} ${missing.length === 1 ? "person never worked" : "people never worked"} a shift they're trained on`,
      summary: missing.slice(0, MAX_LISTED).map((f) => `${f.name}: ${f.missingShifts.map(label).join(", ")}`).join(" · "),
      steps: [
        { where: "3. Permanent Staff", change: "Untick any shift that person shouldn't really be doing, so the schedule stops offering it." },
        { where: "2. Setup", change: "Click Generate schedule again — the optimizer will try to give them that shift." },
      ],
    });
  }

  // 4. Too many days in a row.
  const streaks = rows.filter((f) => f.longestRunExceeded);
  if (streaks.length > 0) {
    tips.push({
      id: "streaks",
      level: "fix",
      impact: { count: 0, text: "Doesn't fill empty shifts (it's about the day limit)" },
      title: `${streaks.length} ${streaks.length === 1 ? "person has" : "people have"} too many days in a row`,
      summary: streaks.slice(0, MAX_LISTED).map((f) => `${f.name}: ${f.longestRun} days (limit ${settings.maxConsecutiveDays})`).join(" · "),
      steps: [
        { where: "2. Setup", change: `Tick "Hard limit" next to Max consecutive days so ${settings.maxConsecutiveDays} is a real ceiling.` },
        { where: "3. Permanent Staff", change: "If that person has five or more fixed days, untick any you don't really need." },
        { where: "2. Setup", change: "Click Generate schedule again." },
      ],
    });
  }

  // 5. Scattered days off and single shifts.
  const lonely = rows
    .map((f) => ({ name: f.name, days: f.lonelyDaysOff || 0, shifts: f.lonelyShifts || 0 }))
    .filter((r) => r.days + r.shifts > 0)
    .sort((a, b) => (b.days + b.shifts) - (a.days + a.shifts));
  if (lonely.length > 0) {
    const steps = [];
    if (!settings.groupDaysOff || !settings.avoidLonelyShifts) {
      steps.push({ where: "2. Setup", change: "Tick both \"Group days off together\" and \"Avoid lonely shifts\" under Days off." });
    }
    steps.push({ where: "3. Permanent Staff", change: "Untick fixed days that create a one-day gap (for example Mon and Wed fixed with Tue off)." });
    steps.push({ where: "5. Schedule", change: "Click Regenerate up to three times and keep the result with the fewest holes and lonely shifts." });
    tips.push({
      id: "lonely",
      level: "tip",
      impact: { count: 0, text: "Doesn't fill empty shifts (tidies the week instead)" },
      title: "Some days off and shifts are scattered",
      summary: lonely.slice(0, MAX_LISTED).map((r) => `${r.name}: ${r.days} lonely day${r.days === 1 ? "" : "s"} off, ${r.shifts} lonely shift${r.shifts === 1 ? "" : "s"}`).join(" · "),
      steps,
    });
  }

  // 6. Rule violations the matcher should never produce — flag if they do.
  const violations = [
    ...(schedule.shiftCapViolations || []),
    ...(schedule.cappedFixedDayViolations || []),
    ...((schedule.continuityCheck && schedule.continuityCheck.violations) || []),
  ];
  if (violations.length > 0) {
    tips.push({
      id: "violations",
      level: "fix",
      impact: { count: 0, text: "Doesn't fill empty shifts — these should not happen" },
      title: `${violations.length} rule violation${violations.length === 1 ? "" : "s"} in this schedule`,
      summary: violations.slice(0, MAX_LISTED).join(" · "),
      steps: [
        { where: "5. Schedule", change: "Click Regenerate. These shouldn't happen, so if they keep showing up, note the names and tell the developer." },
      ],
    });
  }

  if (tips.length === 0) {
    return [{ id: "ok", level: "ok", impact: { count: 0, text: "" }, title: "Nothing to fix — this schedule looks good", summary: "No unfilled shifts, streak problems, scattered days off, or rule violations.", steps: [] }];
  }
  // Highest impact on empty shifts first. Array.sort is stable, so tips
  // with the same impact keep their order above.
  return [...tips].sort((a, b) => b.impact.count - a.impact.count).map((tip, i) => ({ ...tip, priority: i + 1 }));
}
