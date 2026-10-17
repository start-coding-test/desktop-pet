// overlay：宠物悬浮卡。三环 + 本期成本 + 更新时间；内容由 main 推来的 *:widget 驱动。
// 位置/高度由 main 通过 overlay.show({x,y,height}) 传，视图不碰窗口 API。
import { fmtDateTime, fmtMoney } from "../format.js";
import { TOPIC_CMD, TOPIC_WIDGET } from "../topics.js";
import { addStyle, tag, text } from "./dom.js";
import { createRing, RING_CSS } from "./rings.js";
import { setClassIfChanged, setTextIfChanged } from "./write.js";

const CSS = `
  .g-card { width: 300px; box-sizing: border-box; margin: 2px auto; padding: 6px 10px;
    border-radius: 14px; background: rgba(16,18,24,.92); border: 1px solid rgba(255,255,255,.1);
    box-shadow: 0 8px 26px rgba(0,0,0,.42); color: #f2f5f8;
    font: 12px/1.35 "Segoe UI", "Microsoft YaHei", sans-serif; overflow: hidden; }
  .g-card .g-head { display: flex; justify-content: space-between; align-items: baseline;
    font-size: 10.5px; color: #9aa3b2; margin-bottom: 3px; gap: 8px; }
  .g-card .g-title { font-weight: 600; color: #eef2f6; }
  .g-card .g-foot { display: flex; justify-content: space-between; align-items: baseline;
    margin-top: 2px; font-size: 10px; color: #9aa3b2; gap: 8px; }
  .g-card .g-foot .g-error { color: #ff8a8a; }
  .g-card .g-rings { gap: 4px; }
`;

export function mountOverlay(root, ctx, cleanups) {
  const dom = ctx.dom;
  addStyle(dom, root, `${RING_CSS}\n${CSS}`);

  const card = tag(dom, "div", "g-card");
  const head = tag(dom, "div", "g-head");
  const title = text(dom, "GOAT", "g-title");
  const updated = text(dom, "", "g-muted");
  head.append(title, updated);

  const rings = tag(dom, "div", "g-rings");
  const five = createRing(dom, { size: 46, label: "5 小时", kind: "five_hour" });
  const weekly = createRing(dom, { size: 46, label: "本周", kind: "weekly" });
  const monthly = createRing(dom, { size: 46, label: "本月", kind: "monthly" });
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
