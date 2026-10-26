// overlay：宠物悬浮卡。三环 + 本期成本 + 更新时间；内容由 main 推来的 *:widget 驱动。
// 位置/高度由 main 通过 overlay.show({x,y,height}) 传，视图不碰窗口 API。
import { fmtDateTime, fmtMoney } from "../format.js";
import { TOPIC_CMD, TOPIC_WIDGET } from "../topics.js";
import { addStyle, tag, text } from "./dom.js";
import { createRing, RING_CSS } from "./rings.js";
import { setClassIfChanged, setTextIfChanged } from "./write.js";

export const OVERLAY_LAYOUT = {
  height: 168,
  paddingY: 10,
  head: 16,
  rings: 96,
  foot: 14,
  gap: 4,
};

export function overlayContentHeight() {
  return OVERLAY_LAYOUT.head + OVERLAY_LAYOUT.rings + OVERLAY_LAYOUT.foot + OVERLAY_LAYOUT.gap * 2;
}

export const OVERLAY_CSS = `
  .g-card {
    --g-dark-bg: #0f141d; --g-dark-surface: #161d29; --g-dark-border: rgba(255,255,255,.12);
    --g-dark-text: #f2f5f8; --g-dark-muted: #9aa6b6; --g-dark-accent: #7aa2ff;
    --g-dark-success: #3ddc97; --g-dark-warning: #f5c451; --g-dark-danger: #ff7b7b;
    --g-ring-value: #f2f5f8; --g-ring-label: #9aa6b6; --g-ring-reset: #98a2b3;
    --g-ring-track: rgba(255,255,255,.14); --g-ring-success: #3ddc97;
    --g-ring-warning: #f5c451; --g-ring-danger: #ff7b7b; --g-ring-muted: #8b95a5;
    --g-ring-stroke: 6.5px; --g-ring-value-size: 13px; --g-ring-label-size: 9px;
    --g-ring-reset-size: 8.5px; --g-ring-gap: 8px; --g-ring-item-gap: 2px;
    width: 300px; box-sizing: border-box; margin: 2px auto 0; padding: 10px 14px;
    display: flex; flex-direction: column; gap: 4px; border-radius: 18px;
    background: linear-gradient(160deg, #161d29, #0f141d);
    border: 1px solid var(--g-dark-border); box-shadow: 0 2px 6px rgba(0,0,0,.35);
    color: var(--g-dark-text); font: 12px/1.35 "Segoe UI Variable", "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  .g-card .g-head { display: flex; justify-content: space-between; align-items: baseline;
    min-height: 16px; gap: 8px; }
  .g-card .g-title { font-weight: 650; font-size: 12px; color: var(--g-dark-text); }
  .g-card .g-head .g-muted { color: var(--g-dark-muted); font-size: 10px; }
  .g-card .g-rings { min-height: 96px; gap: 8px; }
  .g-card .g-foot { display: flex; justify-content: space-between; align-items: center;
    min-height: 14px; gap: 8px; font-size: 10.5px; color: var(--g-dark-muted); }
  .g-card .g-cost { color: var(--g-dark-text); background: rgba(122,162,255,.12);
    border: 1px solid rgba(122,162,255,.22); border-radius: 999px; padding: 2px 8px;
    font-weight: 600; white-space: nowrap; }
  .g-card .g-foot .g-note { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .g-card .g-foot .g-error { color: var(--g-dark-danger); }
`;

export function mountOverlay(root, ctx, cleanups) {
  const dom = ctx.dom;
  addStyle(dom, root, `${RING_CSS}\n${OVERLAY_CSS}`);

  const card = tag(dom, "div", "g-card");
  const head = tag(dom, "div", "g-head");
  const title = text(dom, "GOAT", "g-title");
  const updated = text(dom, "", "g-muted");
  head.append(title, updated);

  const rings = tag(dom, "div", "g-rings");
  const five = createRing(dom, { size: 50, label: "5 小时", kind: "five_hour" });
  const weekly = createRing(dom, { size: 50, label: "本周", kind: "weekly" });
  const monthly = createRing(dom, { size: 50, label: "本月", kind: "monthly" });
  rings.append(five.box, weekly.box, monthly.box);

  const foot = tag(dom, "div", "g-foot");
  const cost = text(dom, "", "g-cost");
  const note = text(dom, "", "g-note");
  foot.append(cost, note);

  card.append(head, rings, foot);

  let lastView = null;
  let mounted = false;
  const cache = {};

  function updateRings(view, now = Date.now()) {
    five.update(view.windows.five_hour, now);
    weekly.update(view.windows.weekly, now);
    monthly.update(view.windows.monthly, now);
  }

  function render(view) {
    lastView = view ?? null;
    const d = lastView;
    if (!d || !d.account || !d.windows) {
      if (mounted) card.remove();
      mounted = false;
      return;
    }
    updateRings(d);

    setTextIfChanged(
      updated,
      d.fetchedAt ? fmtDateTime(d.fetchedAt) : "尚未刷新",
      cache,
      "updated",
    );
    const value = Number(d.usage?.total_cost);
    setTextIfChanged(
      cost,
      Number.isFinite(value) ? `本期 ${fmtMoney(value, d.config ?? {})}` : "本期 —",
      cache,
      "cost",
    );
    if (d.state === "auth_error") {
      setClassIfChanged(note, "g-note g-error", cache, "noteClass");
      setTextIfChanged(note, "凭据失效，暂停更新", cache, "note");
    } else if (d.state === "stale") {
      setClassIfChanged(note, "g-note", cache, "noteClass");
      setTextIfChanged(note, "数据过期", cache, "note");
    } else {
      setClassIfChanged(note, "g-note", cache, "noteClass");
      setTextIfChanged(
        note,
        d.account.mode === "demo" ? "演示模式" : (d.plan?.name ?? ""),
        cache,
        "note",
      );
    }

    if (!mounted) {
      root.append(card);
      mounted = true;
    }
  }

  const timer = setInterval(() => {
    // 每秒只重算三环倒计时；头部/底部只在新 :widget 数据时更新。
    if (lastView && mounted) updateRings(lastView);
  }, 1000);
  cleanups.push(() => clearInterval(timer));
  cleanups.push(ctx.bus.subscribe(TOPIC_WIDGET, (view) => render(view ?? {})));
  ctx.bus.publish(TOPIC_CMD, { action: "sync" });
}
