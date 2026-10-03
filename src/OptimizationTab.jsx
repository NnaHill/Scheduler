import { useState } from "react";

// Renders the tips from buildOptimizationTips. Each tip is a card you can
// tick off once you've made the change — the ticks live only on this
// screen and reset when the schedule is regenerated.
export default function OptimizationTab({ tips }) {
  const [done, setDone] = useState({});

  const levelStyle = {
    fix: { label: "Fix first", pill: "bg-[#FEE2E2] text-[#991B1B]", bar: "border-l-[#DC2626]" },
    tip: { label: "Tip", pill: "bg-[#FEF3C7] text-[#92400E]", bar: "border-l-[#CA8A04]" },
    ok: { label: "All good", pill: "bg-[#ECFDF5] text-[#065F46]", bar: "border-l-[#0D9488]" },
  };

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-bold">Optimization</h2>
        <p className="text-xs text-[#64748B] mt-0.5">
          Based on your most recently generated schedule. Work top to bottom — the first cards matter most. Tick a card off once it's done.
        </p>
      </div>

      {tips.map((tip) => {
        const style = levelStyle[tip.level];
        const isDone = !!done[tip.id];
        return (
          <div key={tip.id} className={`bg-white rounded-lg border border-[#E4E7EC] border-l-4 ${style.bar} p-4 ${isDone ? "opacity-60" : ""}`}>
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <span className={`inline-block text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full mb-1 ${style.pill}`}>{tip.priority ? `Priority ${tip.priority} · ` : ""}{style.label}</span>
                <div className={`text-sm font-semibold ${isDone ? "line-through" : ""}`}>{tip.title}</div>
                {tip.summary && <div className="text-xs text-[#64748B] mt-0.5">{tip.summary}</div>}
                {tip.impact && tip.impact.text && <div className={`text-xs font-semibold mt-1 ${tip.impact.count > 0 ? "text-[#0B6B62]" : "text-[#94A3B8]"}`}>Impact on empty shifts: {tip.impact.text}</div>}
              </div>
              {tip.level !== "ok" && (
                <label className="flex items-center gap-1.5 text-xs text-[#64748B] cursor-pointer whitespace-nowrap">
                  <input type="checkbox" checked={isDone} onChange={(e) => setDone((prev) => ({ ...prev, [tip.id]: e.target.checked }))} />
                  Done
                </label>
              )}
            </div>

            {tip.steps.length > 0 && (
              <ol className="mt-3 space-y-2">
                {tip.steps.map((step, i) => (
                  <li key={i} className="flex gap-3 text-xs">
                    <span className="flex-none w-5 h-5 rounded-full bg-[#E6F6F4] text-[#0B6B62] font-bold flex items-center justify-center">{i + 1}</span>
                    <div>
                      <span className="font-semibold text-[#1A2233]">{step.where}:</span>{" "}
                      <span className="text-[#33405A]">{step.change}</span>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        );
      })}
    </div>
  );
}
