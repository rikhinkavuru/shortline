// Availability index chart: responsive SVG with weekly points, a 95% band,
// the dashed shortage threshold, hollow markers for insufficient weeks,
// per-point tooltips, and a text summary for assistive technology.

import { esc, fmtInterval, fmtPct, humanSignal, weekShort } from "/ui/format.js";
import { EmptyState } from "/ui/components.js";

const observers = new WeakMap();

export function renderChart(container, inputs) {
  if (!container) return;
  container.__chartInputs = inputs;
  draw(container);
  if (!observers.has(container) && typeof ResizeObserver !== "undefined") {
    let last = container.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = container.clientWidth;
      if (Math.abs(w - last) > 4) {
        last = w;
        draw(container);
      }
    });
    ro.observe(container);
    observers.set(container, ro);
  }
}

function draw(container) {
  const { estimates = [], threshold = 0.5, minUsable = 6 } = container.__chartInputs ?? {};
  if (!estimates.length) {
    container.innerHTML = EmptyState({ icon: "bar-chart", title: "No weekly estimates yet", hint: "Run a sweep to start the index.", compact: true });
    return;
  }
  const W = Math.max(300, Math.floor(container.clientWidth || 720));
  const narrow = W < 480;
  const H = narrow ? 210 : 250;
  const padL = 40, padR = 14, padT = 26, padB = 30;
  const n = estimates.length;
  const xs = estimates.map((_, i) => padL + (n === 1 ? (W - padL - padR) / 2 : (i * (W - padL - padR)) / (n - 1)));
  const y = (v) => padT + (1 - Math.min(1, Math.max(0, v))) * (H - padT - padB);
  const pts = estimates.map((e, i) => ({ e, i, x: xs[i], p: e.overall?.pHat ?? null, lo: e.overall?.low ?? null, hi: e.overall?.high ?? null, ok: e.signal !== "insufficient_data" && e.overall?.pHat !== null && e.overall?.pHat !== undefined }));
  const solid = pts.filter((p) => p.ok);
  const bandPts = solid.filter((p) => p.lo !== null && p.hi !== null);
  const band = bandPts.length > 1 ? `M ${bandPts.map((p) => `${p.x.toFixed(1)} ${y(p.hi).toFixed(1)}`).join(" L ")} L ${bandPts.slice().reverse().map((p) => `${p.x.toFixed(1)} ${y(p.lo).toFixed(1)}`).join(" L ")} Z` : "";
  const line = solid.length > 1 ? `M ${solid.map((p) => `${p.x.toFixed(1)} ${y(p.p).toFixed(1)}`).join(" L ")}` : "";
  const grid = [0, 0.25, 0.5, 0.75, 1].map((v) => `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="tick" x="${padL - 8}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end">${Math.round(v * 100)}%</text>`).join("");
  const every = narrow && n > 6 ? 2 : 1;
  const labels = pts.map((p) => (p.i % every === 0 || p.i === n - 1 ? `<text class="tick" x="${p.x.toFixed(1)}" y="${H - 9}" text-anchor="middle">${esc(weekShort(p.e.isoWeek))}</text>` : "")).join("");
  const ty = y(threshold);
  const thresh = `<line class="thresh" x1="${padL}" x2="${W - padR}" y1="${ty.toFixed(1)}" y2="${ty.toFixed(1)}"/><text class="thresh-label" x="${padL + 6}" y="${(ty - 5).toFixed(1)}">upper bound &lt; ${Math.round(threshold * 100)}%</text>`;
  const sim = estimates.some((e) => e.simulated) ? `<text class="sim-label" x="${W - padR}" y="${padT - 10}" text-anchor="end">SIMULATED HISTORY</text>` : "";
  const markers = pts
    .map((p) => {
      const cy = p.p === null ? y(0) : y(p.p);
      const usable = p.e.usable ?? 0;
      const flags = [p.e.simulated ? "simulated" : "", p.ok ? "" : "insufficient data"].filter(Boolean).join(", ");
      const label = `${p.e.isoWeek}: ${p.ok ? `${fmtPct(p.p)} (95% interval ${fmtInterval(p.lo, p.hi)}), n=${usable}` : `not enough data, ${usable} usable of ${minUsable} needed`}${flags ? `; ${flags}` : ""}`;
      const cls = p.ok ? `pt ${esc(p.e.signal)}` : "pt hollow";
      return `<g class="pt-group" tabindex="0" role="img" aria-label="${esc(label)}" data-i="${p.i}"><circle class="pt-hit" cx="${p.x.toFixed(1)}" cy="${cy.toFixed(1)}" r="12"/><circle class="${cls}" cx="${p.x.toFixed(1)}" cy="${cy.toFixed(1)}" r="${p.ok ? 4.5 : 4.5}"/></g>`;
    })
    .join("");
  const summaryId = `${container.id || "chart"}-summary`;
  container.innerHTML = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-describedby="${summaryId}" aria-label="Weekly availability estimate with 95% interval">${grid}${thresh}${band ? `<path class="band" d="${band}"/>` : ""}${line ? `<path class="line" d="${line}"/>` : ""}${markers}${labels}${sim}</svg><div class="chart-tip" role="tooltip" hidden></div><p class="sr-only" id="${summaryId}">${esc(summary(estimates, threshold, minUsable))}</p>`;
  wireTooltip(container, pts, minUsable);
}

function summary(estimates, threshold, minUsable) {
  const first = estimates[0], last = estimates[estimates.length - 1];
  const ok = estimates.filter((e) => e.signal !== "insufficient_data" && e.overall?.pHat !== null);
  const lastOk = ok[ok.length - 1];
  const parts = [`Weekly availability estimates for ${estimates.length} week${estimates.length === 1 ? "" : "s"}, ${first.isoWeek} to ${last.isoWeek}.`];
  if (lastOk) parts.push(`Latest estimate ${lastOk.isoWeek}: ${fmtPct(lastOk.overall.pHat)}, 95% interval ${fmtInterval(lastOk.overall.low, lastOk.overall.high)}, ${lastOk.usable} usable answers, signal ${humanSignal(lastOk.signal)}.`);
  const insufficient = estimates.filter((e) => e.signal === "insufficient_data");
  if (insufficient.length) parts.push(`${insufficient.map((e) => `${e.isoWeek} has ${e.usable} usable of ${minUsable} needed`).join("; ")}.`);
  const simulated = estimates.filter((e) => e.simulated);
  if (simulated.length) parts.push(`${simulated.length} week${simulated.length === 1 ? " is" : "s are"} simulated history.`);
  parts.push(`Shortage threshold: upper bound below ${Math.round(threshold * 100)}%.`);
  return parts.join(" ");
}

function wireTooltip(container, pts, minUsable) {
  const tip = container.querySelector(".chart-tip");
  const svg = container.querySelector("svg");
  if (!tip || !svg) return;
  const show = (g) => {
    const p = pts[Number(g.dataset.i)];
    if (!p) return;
    const rows = [
      `<b>${esc(p.e.isoWeek)}</b>`,
      p.ok ? `Estimate ${esc(fmtPct(p.p))}` : `No estimate`,
      p.ok ? `95% interval ${esc(fmtInterval(p.lo, p.hi))}` : `${esc(p.e.usable ?? 0)} usable of ${esc(minUsable)} needed`,
      `n = ${esc(p.e.usable ?? 0)} usable of ${esc(p.e.planned ?? 0)} asked`,
      `${esc(humanSignal(p.e.signal))}${p.e.simulated ? " · simulated" : ""}${p.ok ? "" : " · insufficient data"}`
    ];
    tip.innerHTML = rows.map((r) => `<span>${r}</span>`).join("");
    tip.hidden = false;
    const c = g.querySelector(".pt");
    const cr = c.getBoundingClientRect();
    const box = container.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = cr.left - box.left + cr.width / 2 - tw / 2;
    left = Math.max(4, Math.min(box.width - tw - 4, left));
    let top = cr.top - box.top - th - 10;
    if (top < 0) top = cr.top - box.top + cr.height + 10;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };
  const hide = () => {
    tip.hidden = true;
  };
  for (const g of svg.querySelectorAll(".pt-group")) {
    g.addEventListener("mouseenter", () => show(g));
    g.addEventListener("focus", () => show(g));
    g.addEventListener("mouseleave", hide);
    g.addEventListener("blur", hide);
  }
}
