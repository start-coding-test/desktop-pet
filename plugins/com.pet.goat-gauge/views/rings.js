// 三环的共用小件：overlay 与插件页概览都用它。
// 圆环进度用 path 的 d；线宽/线帽放在 CSS 里（契约没有 stroke-width 属性）。
import { arcPath, toneOfPct } from "../charts.js";
import { fmtCountdown, fmtPct } from "../format.js";
import { svg, tag, text } from "./dom.js";
import { setAttrIfChanged, setClassIfChanged, setDatasetIfChanged, setTextIfChanged } from "./write.js";

export const RING_CSS = `
  .g-rings { display: flex; justify-content: space-between; align-items: center;
    gap: var(--g-ring-gap, 10px); }
  .g-ring { display: flex; flex-direction: column; align-items: center;
    gap: var(--g-ring-item-gap, 3px); min-width: 0; }
  .g-ring-svg { display: block; }
  .g-ring-track { fill: none; stroke: var(--g-ring-track, rgba(255,255,255,.14));
    stroke-width: var(--g-ring-stroke, 7px); }
  .g-ring-progress { fill: none; stroke-width: var(--g-ring-stroke, 7px); stroke-linecap: round; }
  .g-ring.good .g-ring-progress { stroke: var(--g-ring-success, #3ddc97); }
  .g-ring.warn .g-ring-progress { stroke: var(--g-ring-warning, #f5c451); }
  .g-ring.bad .g-ring-progress { stroke: var(--g-ring-danger, #ff7b7b); }
  .g-ring-value { font-size: var(--g-ring-value-size, 15px); font-weight: 600;
    color: var(--g-ring-value, #f2f5f8); }
  .g-ring-label { font-size: var(--g-ring-label-size, 11px); color: var(--g-ring-label, #9aa6b6); }
  .g-ring-reset { font-size: var(--g-ring-reset-size, 9.5px); color: var(--g-ring-reset, #98a2b3); }
  .g-ring.unavailable .g-ring-value, .g-ring.unavailable .g-ring-reset {
    color: var(--g-ring-muted, #8b95a5); }
`;

/**
 * @param {any} dom
 * @param {{ size?: number, label: string, kind: string }} options
 */
export function createRing(dom, { size = 64, label, kind }) {
  const box = tag(dom, "div", "g-ring");
  box.dataset.ring = kind;

  const radius = size / 2 - 4;
  const center = size / 2;
  const chart = svg(dom, "svg", {
    viewBox: `0 0 ${size} ${size}`,
    width: size,
    height: size,
    class: "g-ring-svg",
  });
  const track = svg(dom, "circle", {
    cx: center,
    cy: center,
    r: radius,
    class: "g-ring-track",
  });
  const progress = svg(dom, "path", {
    d: "",
    class: "g-ring-progress",
  });
  progress.dataset.role = "ring-progress";
  chart.append(track, progress);

  const value = text(dom, "—", "g-ring-value");
  value.dataset.role = "ring-value";
  const labelNode = text(dom, label, "g-ring-label");
  const reset = text(dom, "—", "g-ring-reset");
  reset.dataset.role = "ring-reset";
  box.append(chart, value, labelNode, reset);
  const cache = {};

  /**
   * @param {Record<string, any> | null | undefined} window
   * @param {number} now
   */
  function update(window, now = Date.now()) {
    const available = window && window.available !== false;
    const pct = available ? Number(window.remaining_pct) : Number.NaN;
    if (!available || !Number.isFinite(pct)) {
      setAttrIfChanged(progress, "d", "", cache);
      setTextIfChanged(value, "—", cache, "value");
      setTextIfChanged(reset, String(window?.note ?? "—"), cache, "reset");
      setClassIfChanged(box, "g-ring unavailable", cache);
      setDatasetIfChanged(box, "state", window ? "unavailable" : "empty", cache);
      return;
    }
    setAttrIfChanged(progress, "d", arcPath(center, center, radius, pct), cache);
    setTextIfChanged(value, fmtPct(pct), cache, "value");
    const resetAt = Number(window.reset_at) || 0;
    setTextIfChanged(reset, resetAt > now ? fmtCountdown(resetAt, now) : "已重置", cache, "reset");
    setClassIfChanged(box, `g-ring ${toneOfPct(pct)}`, cache);
    setDatasetIfChanged(box, "state", window.exceeded === true ? "exceeded" : "ok", cache);
  }

  return { box, chart, progress, value, reset, update };
}
