// 插件页共用样式与小件。设置页是浅色；额度卡故意用深色，三环文字沿用 RING_CSS。
import { RING_CSS } from "../rings.js";

export const SETTINGS_CSS = `
  .g-set { display: flex; flex-direction: column; gap: 10px; max-width: 760px; margin: 0 auto;
    color: #2b2f36; font: 12.5px/1.5 "Segoe UI", "Microsoft YaHei", sans-serif; }
  .g-tabs { display: flex; gap: 4px; border-bottom: 1px solid #eaecf0; }
  .g-tab { border: none; background: none; padding: 6px 12px; cursor: pointer;
    color: #667085; border-bottom: 2px solid transparent; font-size: 12.5px; }
  .g-tab.active { color: #1570ef; border-bottom-color: #1570ef; font-weight: 600; }
  .g-status { min-height: 16px; font-size: 11.5px; color: #667085; }
  .g-status.ok { color: #067647; } .g-status.error { color: #d92d20; } .g-status.warn { color: #b54708; }
  .g-pane { display: none; flex-direction: column; gap: 10px; }
  .g-pane.active { display: flex; }
  .g-card { background: #fff; border: 1px solid #eaecf0; border-radius: 10px; padding: 10px 12px; }
  .g-card-t { font-weight: 600; margin-bottom: 6px; }
  .g-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .g-muted { color: #98a2b3; font-size: 11.5px; }
  .g-hidden { display: none; }
  .g-input, .g-set select { border: 1px solid #d0d5dd; border-radius: 6px; padding: 4px 7px;
    font-size: 12px; color: #2b2f36; background: #fff; }
  .g-input[type=password] { width: 260px; }
  .g-num { width: 84px; }
  .g-btn { border: 1px solid #d0d5dd; background: #fff; border-radius: 6px; padding: 4px 11px;
    font-size: 12px; color: #344054; cursor: pointer; }
  .g-btn:hover { background: #f9fafb; }
  .g-btn.primary { background: #1570ef; border-color: #1570ef; color: #fff; }
  .g-btn:disabled { opacity: .5; cursor: default; }
  .g-checks { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
  .g-checks label { display: inline-flex; gap: 4px; align-items: center; }
  .g-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
  .g-kpi { background: #f9fafb; border: 1px solid #eaecf0; border-radius: 8px; padding: 8px; }
  .g-kpi b { display: block; font-size: 15px; color: #1d2939; }
  .g-kpi span { font-size: 11px; color: #667085; }
  .g-quota { background: #11131a; border-color: #1f2430; color: #eef2f6; }
  .g-quota .g-card-t { color: #cfd6e0; }
  .g-alerts { display: flex; flex-direction: column; gap: 4px; }
  .g-alert { padding: 5px 8px; border-radius: 6px; font-size: 11.5px; }
  .g-alert.danger { background: #fef3f2; color: #b42318; }
  .g-alert.warning { background: #fffaeb; color: #b54708; }
  .g-alert.info { background: #eff8ff; color: #175cd3; }
  .g-acct { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .g-acct b { font-size: 14px; color: #1d2939; }
  .g-chart-box { background: #fff; border: 1px solid #eaecf0; border-radius: 10px; padding: 8px; }
  .g-chart { width: 100%; height: 160px; display: block; }
  .g-grid { stroke: #eaecf0; stroke-width: 1; }
  .g-line { fill: none; stroke-width: 2; }
  .g-line.five { stroke: #1570ef; } .g-line.weekly { stroke: #f5c518; } .g-line.monthly { stroke: #12b76a; }
  .g-legend { display: flex; gap: 12px; font-size: 11px; color: #667085; }
  .g-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 4px; }
  .g-dot.five { background: #1570ef; } .g-dot.weekly { background: #f5c518; } .g-dot.monthly { background: #12b76a; }
  .g-form { display: flex; flex-direction: column; gap: 8px; }
  .g-error { color: #d92d20; }
  .g-note { color: #b54708; font-size: 11.5px; }
  .g-detail-tabs { margin-bottom: 4px; }
  .g-detail-table { display: flex; flex-direction: column; gap: 2px; }
  .g-detail-row { display: grid; grid-template-columns: 138px minmax(0, 1fr) 96px 92px;
    gap: 8px; padding: 3px 0; border-bottom: 1px solid #f2f4f7; font-size: 11.5px; }
  .g-detail-pager { justify-content: flex-end; }
  ${RING_CSS}
`;
