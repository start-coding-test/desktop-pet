// 插件页共用样式与小件。设置页是浅色；额度卡故意用深色，三环文字沿用 RING_CSS。
import { RING_CSS } from "../rings.js";

export const SETTINGS_CSS = `
  .g-set {
    --g-canvas: #f6f8fc; --g-surface: #ffffff; --g-surface-2: #f9fafb;
    --g-border: #e4e9f2; --g-border-strong: #d0d9e8;
    --g-text: #182230; --g-text-2: #475467; --g-muted: #667085;
    --g-accent: #2563eb; --g-accent-soft: #eff6ff; --g-on-accent: #ffffff;
    --g-success: #12b76a; --g-warning: #f5a524; --g-danger: #e5484d;
    --g-success-text: #067647; --g-warning-text: #b54708; --g-danger-text: #b42318; --g-info-text: #175cd3;
    --g-success-soft: #ecfdf3; --g-warning-soft: #fffaeb; --g-danger-soft: #fef3f2; --g-info-soft: #eff8ff;
    display: flex; flex-direction: column; gap: 12px; max-width: 760px; margin: 0 auto;
    padding: 14px; color: var(--g-text); background: var(--g-canvas);
    border: 1px solid var(--g-border); border-radius: 18px; box-sizing: border-box;
    font: 12.5px/1.5 "Segoe UI Variable", "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  .g-tabs { display: flex; gap: 2px; padding: 3px; border: 1px solid var(--g-border);
    border-radius: 999px; background: var(--g-surface-2); }
  .g-tab { border: none; background: none; padding: 6px 14px; cursor: pointer;
    border-radius: 999px; color: var(--g-muted); font-size: 12.5px; }
  .g-tab:hover { color: var(--g-text-2); }
  .g-tab.active { color: var(--g-accent); background: var(--g-surface); font-weight: 600;
    border-bottom-color: transparent; box-shadow: 0 1px 2px rgba(16,24,40,.06); }
  .g-status { min-height: 16px; font-size: 11.5px; color: var(--g-muted); }
  .g-status.ok { color: var(--g-success-text); }
  .g-status.error { color: var(--g-danger-text); }
  .g-status.warn { color: var(--g-warning-text); }
  .g-pane { display: none; flex-direction: column; gap: 12px; }
  .g-pane.active { display: flex; }
  .g-card { background: var(--g-surface); border: 1px solid var(--g-border); border-radius: 16px;
    padding: 14px 16px; box-shadow: 0 1px 2px rgba(16,24,40,.04), 0 8px 24px rgba(16,24,40,.04); }
  .g-card-t { font-weight: 600; font-size: 13.5px; color: var(--g-text); margin-bottom: 8px; }
  .g-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .g-muted { color: var(--g-muted); font-size: 11px; }
  .g-hidden { display: none; }
  .g-input, .g-set select { border: 1px solid var(--g-border-strong); border-radius: 8px;
    padding: 6px 9px; font-size: 12px; color: var(--g-text); background: var(--g-surface); }
  .g-input:focus, .g-set select:focus, .g-btn:focus-visible {
    outline: 2px solid var(--g-accent-soft); outline-offset: 1px; border-color: var(--g-accent); }
  .g-input[type=password] { width: 260px; }
  .g-num { width: 84px; }
  .g-btn { border: 1px solid var(--g-border-strong); background: var(--g-surface); border-radius: 8px;
    padding: 6px 12px; font-size: 12px; color: var(--g-text-2); cursor: pointer; }
  .g-btn:hover { background: var(--g-surface-2); }
  .g-btn.primary { background: var(--g-accent); border-color: var(--g-accent); color: var(--g-on-accent); }
  .g-btn:disabled { opacity: .5; cursor: default; }
  .g-checks { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
  .g-checks label { display: inline-flex; gap: 4px; align-items: center; }
  .g-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
  .g-kpi { background: var(--g-surface-2); border: 1px solid var(--g-border);
    border-radius: 12px; padding: 10px; }
  .g-kpi b { display: block; font-size: 18px; line-height: 1.2; color: var(--g-text); font-weight: 650; }
  .g-kpi span { font-size: 11px; color: var(--g-muted); }
  .g-kpi.g-kpi-wide { grid-column: span 2;
    background: linear-gradient(135deg, var(--g-accent-soft), var(--g-surface)); border-color: #dbeafe; }
  .g-quota {
    --g-dark-bg: #0f141d; --g-dark-surface: #161d29; --g-dark-border: rgba(255,255,255,.12);
    --g-dark-text: #f2f5f8; --g-dark-muted: #9aa6b6; --g-dark-accent: #7aa2ff;
    --g-dark-success: #3ddc97; --g-dark-warning: #f5c451; --g-dark-danger: #ff7b7b;
    --g-ring-value: #f2f5f8; --g-ring-label: #9aa6b6; --g-ring-reset: #98a2b3;
    --g-ring-track: rgba(255,255,255,.14); --g-ring-success: #3ddc97;
    --g-ring-warning: #f5c451; --g-ring-danger: #ff7b7b; --g-ring-muted: #8b95a5;
    --g-ring-stroke: 7px; --g-ring-value-size: 15px; --g-ring-label-size: 11px;
    --g-ring-reset-size: 9.5px; --g-ring-gap: 10px;
    background: linear-gradient(150deg, var(--g-dark-surface), var(--g-dark-bg));
    border: 1px solid var(--g-dark-border); border-radius: 18px; color: var(--g-dark-text);
    box-shadow: 0 12px 30px rgba(15,20,29,.18);
  }
  .g-quota .g-card-t { color: var(--g-dark-text); }
  .g-alerts { display: flex; flex-direction: column; gap: 6px; }
  .g-alert { padding: 7px 10px; border-radius: 10px; font-size: 11.5px;
    border-left: 3px solid var(--g-border-strong); }
  .g-alert.danger { background: var(--g-danger-soft); color: var(--g-danger-text); border-left-color: var(--g-danger); }
  .g-alert.warning { background: var(--g-warning-soft); color: var(--g-warning-text); border-left-color: var(--g-warning); }
  .g-alert.info { background: var(--g-info-soft); color: var(--g-info-text); border-left-color: var(--g-accent); }
  .g-acct { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .g-acct b { font-size: 14px; color: var(--g-text); }
  .g-chart-box { background: var(--g-surface); border: 1px solid var(--g-border);
    border-radius: 16px; padding: 10px; }
  .g-chart { width: 100%; height: 160px; display: block; }
  .g-grid { stroke: var(--g-border); stroke-width: 1; }
  .g-line { fill: none; stroke-width: 2.25; }
  .g-line.five { stroke: var(--g-accent); }
  .g-line.weekly { stroke: var(--g-warning); }
  .g-line.monthly { stroke: var(--g-success); }
  .g-legend { display: flex; gap: 12px; font-size: 11px; color: var(--g-muted); align-items: center; }
  .g-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 4px; }
  .g-dot.five { background: var(--g-accent); }
  .g-dot.weekly { background: var(--g-warning); }
  .g-dot.monthly { background: var(--g-success); }
  .g-form { display: flex; flex-direction: column; gap: 8px; }
  .g-error { color: var(--g-danger-text); }
  .g-note { color: var(--g-warning-text); font-size: 11.5px; }
  .g-detail-tabs { margin-bottom: 4px; }
  .g-detail-table { display: flex; flex-direction: column; gap: 4px; }
  .g-detail-row { display: grid; grid-template-columns: 138px minmax(0, 1fr) 96px 92px;
    gap: 8px; padding: 6px 8px; border: 1px solid var(--g-border); border-radius: 8px;
    background: var(--g-surface); font-size: 11.5px; }
  .g-detail-row:nth-child(even) { background: var(--g-surface-2); }
  .g-detail-pager { justify-content: flex-end; }
  ${RING_CSS}
`;
