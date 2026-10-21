// 插件页装配壳：概览 / 趋势 / 设置三页，分节实现放在 settings/ 下。
import { TOPIC_CMD, TOPIC_PANEL, TOPIC_STATUS, TOPIC_WIDGET } from "../topics.js";
import { addStyle, tag } from "./dom.js";
import { mountDashboard } from "./settings/dashboard.js";
import { mountDetails } from "./settings/details.js";
import { mountOnboarding } from "./settings/onboarding.js";
import { mountPrefs } from "./settings/prefs.js";
import { mountTrend } from "./settings/trend.js";
import { SETTINGS_CSS } from "./settings/util.js";

export function mountSettings(root, ctx, cleanups) {
  const dom = ctx.dom;
  addStyle(dom, root, SETTINGS_CSS);

  const wrap = tag(dom, "div", "g-set");
  const tabs = tag(dom, "div", "g-tabs");
  const statusLine = tag(dom, "div", "g-status");
  statusLine.textContent = "正在读取当前配置…";

  const state = {
    status: {
      set(content, level = "info") {
        statusLine.textContent = String(content ?? "");
        statusLine.className = `g-status${level === "info" ? "" : ` ${level}`}`;
      },
    },
    lastView: {},
    lastPanel: null,
  };

  const onboarding = mountOnboarding(ctx, state);
  const dashboard = mountDashboard(ctx, cleanups);
  const trend = mountTrend(ctx, state);
  const details = mountDetails(ctx, state);
  const prefs = mountPrefs(ctx, state);

  const panes = {
    overview: tag(dom, "div", "g-pane"),
    trend: tag(dom, "div", "g-pane"),
    details: tag(dom, "div", "g-pane"),
    prefs: tag(dom, "div", "g-pane"),
  };
  panes.overview.append(onboarding.box, dashboard.box);
  panes.trend.append(trend.box);
  panes.details.append(details.box);
  panes.prefs.append(prefs.box);

  const buttons = {};
  const setTab = (name) => {
    for (const [key, pane] of Object.entries(panes)) {
      pane.className = `g-pane${key === name ? " active" : ""}`;
    }
    for (const [key, buttonNode] of Object.entries(buttons)) {
      buttonNode.className = `g-tab${key === name ? " active" : ""}`;
    }
  };
  for (const [key, label] of [
    ["overview", "概览"],
    ["trend", "趋势"],
    ["details", "明细"],
    ["prefs", "设置"],
  ]) {
    const buttonNode = tag(dom, "button", "g-tab");
    buttonNode.type = "button";
    buttonNode.textContent = label;
    buttonNode.on("click", () => setTab(key));
    tabs.append(buttonNode);
    buttons[key] = buttonNode;
  }

  wrap.append(tabs, statusLine, panes.overview, panes.trend, panes.prefs);
  root.append(wrap);
  setTab("overview");

  const render = (view) => {
    state.lastView = view ?? {};
    onboarding.render(state.lastView);
    dashboard.render(state.lastView);
    prefs.render(state.lastView);
    trend.render(state.lastPanel);
    details.render(state.lastPanel, state.lastView);
  };

  cleanups.push(ctx.bus.subscribe(TOPIC_WIDGET, (view) => render(view ?? {})));
  cleanups.push(
    ctx.bus.subscribe(TOPIC_PANEL, (panel) => {
      state.lastPanel = panel ?? null;
      trend.render(state.lastPanel);
    }),
  );
  cleanups.push(
    ctx.bus.subscribe(TOPIC_STATUS, (status) => {
      state.status.set(status?.text ?? "", status?.level ?? "info");
    }),
  );
  ctx.bus.publish(TOPIC_CMD, { action: "sync" });
}
