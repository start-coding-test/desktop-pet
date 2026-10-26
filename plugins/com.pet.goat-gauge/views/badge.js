// badge：宠物旁的小字。没有内容时整块不挂（ADR-0010 决策 1），
// 不能画空框，也不要用 display:none —— 宿主按插槽外壳尺寸判断有没有内容。
import { fmtCountdown, fmtMoney, fmtPct } from "../format.js";
import { toneOfPct } from "../charts.js";
import { TOPIC_CMD, TOPIC_WIDGET } from "../topics.js";
import { addStyle, tag, text } from "./dom.js";
import { setClassIfChanged, setTextIfChanged } from "./write.js";

export const BADGE_CSS = `
  .g-badge {
    --g-badge-bg: #0f141d; --g-badge-surface: #161d29; --g-badge-text: #f2f5f8;
    --g-badge-muted: #9aa6b6; --g-badge-border: rgba(255,255,255,.12);
    --g-badge-success: #3ddc97; --g-badge-warning: #f5c451; --g-badge-danger: #ff7b7b;
    display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px;
    border-radius: 999px; color: var(--g-badge-text);
    background: linear-gradient(180deg, var(--g-badge-surface), var(--g-badge-bg));
    border: 1px solid var(--g-badge-border); box-shadow: 0 2px 6px rgba(0,0,0,.28);
    font: 600 12px/1.35 "Segoe UI Variable", "Segoe UI", "Microsoft YaHei", sans-serif;
    white-space: nowrap;
  }
  .g-badge .g-badge-text { color: var(--g-badge-text); }
  .g-badge .g-dot { width: 7px; height: 7px; border-radius: 50%;
    background: var(--g-badge-muted); }
  .g-badge.good .g-dot { background: var(--g-badge-success); }
  .g-badge.warn .g-dot { background: var(--g-badge-warning); }
  .g-badge.bad .g-dot { background: var(--g-badge-danger); }
`;

const MODES = {
  five_hour: { window: "five_hour", prefix: "5h" },
  weekly: { window: "weekly", prefix: "周" },
  monthly: { window: "monthly", prefix: "月" },
};

export function mountBadge(root, ctx, cleanups) {
  const dom = ctx.dom;
  addStyle(dom, root, BADGE_CSS);

  const badge = tag(dom, "div", "g-badge");
  const dot = tag(dom, "i", "g-dot");
  const label = text(dom, "5h", "g-badge-text");
  badge.append(dot, label);

  let lastView = null;
  let mounted = false;
  const cache = {};

  function show() {
    const d = lastView;
    if (!d || d.state === "onboarding" || !d.account || !d.windows) {
      if (mounted) badge.remove();
      mounted = false;
      return;
    }

    if (d.state === "auth_error") {
      setTextIfChanged(label, "Key 失效", cache, "label");
      setClassIfChanged(badge, "g-badge bad", cache);
      if (!mounted) {
        root.append(badge);
        mounted = true;
      }
      return;
    }

    // 旧存储里的 cost_today 由 store-schema 迁移；视图再兜一层，避免缓存旧 payload。
    const rawMode = d.config?.badgeMode;
    const mode = rawMode === "cost_today" ? "cost_period" : rawMode;
    if (mode === "cost_period") {
      const cost = Number(d.usage?.total_cost);
      if (!Number.isFinite(cost)) {
        if (mounted) badge.remove();
        mounted = false;
        return;
      }
      setClassIfChanged(badge, "g-badge", cache);
      setTextIfChanged(label, `本期 ${fmtMoney(cost, d.config ?? {})}`, cache, "label");
    } else {
      const meta = MODES[mode] ?? MODES.five_hour;
      const window = d.windows?.[meta.window];
      if (!window) {
        if (mounted) badge.remove();
        mounted = false;
        return;
      }
      const now = Date.now();
      const pct = Number(window.remaining_pct);
      const resetAt = Number(window.reset_at) || 0;
      const countdown = resetAt > now ? ` · ${fmtCountdown(resetAt, now)}` : "";
      if (window.exceeded === true) {
        setTextIfChanged(label, `${meta.prefix} 已用尽${countdown}`, cache, "label");
        setClassIfChanged(badge, "g-badge bad", cache);
      } else if (!Number.isFinite(pct)) {
        setTextIfChanged(label, `${meta.prefix} —`, cache, "label");
        setClassIfChanged(badge, "g-badge", cache);
      } else {
        setTextIfChanged(label, `${meta.prefix} ${fmtPct(pct)}${countdown}`, cache, "label");
        setClassIfChanged(badge, `g-badge ${toneOfPct(pct)}`, cache);
      }
    }

    if (!mounted) {
      root.append(badge);
      mounted = true;
    }
  }

  function render(view) {
    lastView = view ?? null;
    show();
  }

  const timer = setInterval(() => {
    if (lastView) show();
  }, 1000);
  cleanups.push(() => clearInterval(timer));
  cleanups.push(ctx.bus.subscribe(TOPIC_WIDGET, (view) => render(view ?? {})));
  ctx.bus.publish(TOPIC_CMD, { action: "sync" });
}
