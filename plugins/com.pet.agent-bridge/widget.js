// 状态卡渲染器。区域约定与心率插件一致：
//   badge   = 宠物旁的一行小字
//   overlay = 桌面左上角的大卡（主视图）
//   settings= 设置窗里的隐私开关 + Qoder hook 接入（ctx.host 只注入给这个区）
// 所有数据来自 `${PID}:widget` topic；敏感字段在 index.js 就已按开关剥掉，
// 这里拿不到就不可能显示，不存在「渲染后再藏起来」的漏洞。
import { TOPIC_CMD, TOPIC_WIDGET } from "./topics.js";

const scopes = new WeakMap();

const STATE_COLOR = {
  running: "#7cc4ff",
  needs_input: "#ffb454",
  completed: "#7ee2a8",
  idle: "#9aa4b2",
};

export function mount(root, ctx) {
  const cleanups = [];
  scopes.set(root, cleanups);
  if (ctx.region === "badge") return mountBadge(root, ctx, cleanups);
  if (ctx.region === "overlay") return mountCard(root, ctx, cleanups);
  if (ctx.region === "settings") return mountSettings(root, ctx, cleanups);
  return undefined;
}

export function unmount(root) {
  for (const off of scopes.get(root) ?? []) {
    try {
      off();
    } catch {
      /* 忽略 */
    }
  }
  scopes.delete(root);
}

function watch(ctx, cleanups, render) {
  cleanups.push(ctx.bus.subscribe(TOPIC_WIDGET, (data) => render(data ?? {})));
}

/* ---------- 宠物旁小字 ---------- */
function mountBadge(root, ctx, cleanups) {
  const style = ctx.dom.createElement("style");
  style.textContent = `
    .ag-badge { display:inline-flex; align-items:center; gap:5px; padding:3px 9px;
      border-radius:9px; font-size:11px; color:#eaf1f8;
      background:rgba(10,14,20,.55); border:1px solid rgba(255,255,255,.12); }
    .ag-badge .dot { width:7px; height:7px; border-radius:50%; background:#9aa4b2; }
  `;
  const el = ctx.dom.createElement("div");
  el.className = "ag-badge";
  const dot = ctx.dom.createElement("i");
  dot.className = "dot";
  const text = ctx.dom.createElement("span");
  el.append(dot, text);
  // 空态（没见过任何会话活动）什么都不进树，外壳尺寸才量得到 0（ADR-0010 落地口径第 1 条）
  root.append(style);

  watch(ctx, cleanups, (d) => {
    const steps = typeof d.steps === "number" ? d.steps : 0;
    const idleEmpty =
      (d.state ?? "idle") === "idle" && steps === 0 && !d.toolName && !d.title && !d.detail;
    if (idleEmpty) {
      el.remove();
      return;
    }
    dot.style.background = STATE_COLOR[d.state] ?? "#9aa4b2";
    text.textContent = `${d.label ?? d.state ?? "待命"}${d.steps ? ` · ${d.steps} 步` : ""}`;
    root.append(el);
  });
}

/* ---------- 桌面左上角大卡 ---------- */
function mountCard(root, ctx, cleanups) {
  const style = ctx.dom.createElement("style");
  style.textContent = `
    .ag-card { width: 300px; padding: 12px 14px 13px; border-radius: 14px;
      background: rgba(16,18,24,.9); border:1px solid rgba(255,255,255,.1);
      box-shadow: 0 8px 26px rgba(0,0,0,.42); color:#f2f5f8;
      font: 13px/1.5 system-ui, "Segoe UI", sans-serif; }
    .ag-card .title { font-size:13px; font-weight:600; color:#fff;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .ag-card .row { display:flex; align-items:center; gap:7px; margin-top:7px; }
    .ag-card .dot { width:8px; height:8px; border-radius:50%; background:#9aa4b2; flex:none; }
    .ag-card .label { font-size:12.5px; }
    .ag-card .steps { margin-left:auto; font-size:11px; color:#98a2b3;
      font-variant-numeric: tabular-nums; }
    .ag-card .detail { margin-top:6px; padding-left:15px; font-size:11.5px; color:#b6c0cd;
      font-family: ui-monospace, Consolas, monospace;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .ag-card.idle { opacity:.62; }
  `;
  const el = ctx.dom.createElement("div");
  el.className = "ag-card idle";
  const title = ctx.dom.createElement("div");
  title.className = "title";
  const row = ctx.dom.createElement("div");
  row.className = "row";
  const dot = ctx.dom.createElement("i");
  dot.className = "dot";
  const label = ctx.dom.createElement("span");
  label.className = "label";
  const steps = ctx.dom.createElement("span");
  steps.className = "steps";
  row.append(dot, label, steps);
  const detail = ctx.dom.createElement("div");
  detail.className = "detail";
  el.append(title, row, detail);
  root.append(style, el);

  watch(ctx, cleanups, (d) => {
    el.classList.toggle("idle", d.state === "idle");
    // 标题被关掉时显示占位，不留空行，也不泄露任何会话内容
    title.textContent = d.title || "Agent 会话";
    dot.style.background = STATE_COLOR[d.state] ?? "#9aa4b2";
    label.textContent = d.label ?? d.state ?? "待命";
    label.style.color = STATE_COLOR[d.state] ?? "#f2f5f8";
    steps.textContent = d.steps ? `${d.steps} 步` : "";
    detail.textContent = d.detail || (d.toolName ? d.toolName : "");
  });
}

/* ---------- 设置面板：隐私开关 ---------- */
function mountSettings(root, ctx, cleanups) {
  const style = ctx.dom.createElement("style");
  style.textContent = `
    .ag-set { font-size:12px; color:#475467; display:grid; gap:6px; }
    .ag-set label { display:flex; align-items:center; gap:6px; }
    .ag-set .note { color:#98a2b3; font-size:11px; }
  `;
  const box = ctx.dom.createElement("div");
  box.className = "ag-set";

  const mk = (key, text, note) => {
    const label = ctx.dom.createElement("label");
    const input = ctx.dom.createElement("input");
    input.type = "checkbox";
    input.dataset.key = key;
    const span = ctx.dom.createElement("span");
    span.textContent = text;
    label.append(input, span);
    box.append(label);
    if (note) {
      const p = ctx.dom.createElement("div");
      p.className = "note";
      p.textContent = note;
      box.append(p);
    }
    return input;
  };
  const title = mk("showTitle", "显示会话标题（首条输入前 48 字）");
  const detail = mk("showDetail", "显示命令 / 路径摘要");
  const note = ctx.dom.createElement("div");
  note.className = "note";
  note.textContent = "默认都关：只显工具名与步数。开了就等于把会话内容常驻显示在桌面上。";
  box.append(note);
  root.append(style, box);

  const send = () =>
    ctx.bus.publish(TOPIC_CMD, {
      action: "config",
      showTitle: title.checked,
      showDetail: detail.checked,
    });
  title.on("change", send);
  detail.on("change", send);
  // 面板是新建的、配置是早就存在的：开口要一次当前值，否则两个开关都显示成关
  ctx.bus.publish(TOPIC_CMD, { action: "sync" });
  cleanups.push(() => {
    title.off("change");
    detail.off("change");
  });

  // 回显当前开关：payload 里带着 config，避免面板重开后显示成默认值
  watch(ctx, cleanups, (d) => {
    title.checked = d.showTitle === true;
    detail.checked = d.showDetail === true;
  });

  // Qoder hook 的装/卸入口（B2 把宿主那张卡片删掉后，这里就是唯一入口）
  mountHookPanel(root, ctx);
}


/* ---------- 设置面板：Agent hook 接入（settings 区专属能力 agent:hooks，见 ADR-0001） ---------- */
function mountHookPanel(root, ctx) {
  const api = ctx.host && ctx.host.agentHooks;
  const style = ctx.dom.createElement("style");
  style.textContent = `
    .hk-box { margin-top:12px; padding-top:10px; border-top:1px dashed rgba(71,84,103,.3);
      font-size:12px; color:#475467; display:grid; gap:6px; }
    .hk-box .hk-hd { font-weight:600; color:#344054; }
    .hk-box .hk-actions { display:flex; gap:6px; flex-wrap:wrap; }
    .hk-box .hk-agents { display:flex; gap:6px; flex-wrap:wrap; }
    .hk-box button { font:inherit; padding:2px 10px; }
    .hk-box .hk-agents button.off { color:#98a2b3; text-decoration:line-through; }
    .hk-box .hk-consent-slot { display:none; }
    .hk-box .hk-consent-slot.on { display:flex; gap:6px; }
    .hk-box .hk-status { white-space:pre-wrap; word-break:break-all; }
    .hk-box .hk-status.warn { color:#b54708; }
    .hk-box .hk-status.bad { color:#dc2626; }
  `;
  const box = ctx.dom.createElement("div");
  box.className = "hk-box";
  const hd = ctx.dom.createElement("div");
  hd.className = "hk-hd";
  hd.textContent = "Agent hook 接入（同一时间只联动一个）";
  const picker = ctx.dom.createElement("div");
  picker.className = "hk-agents";
  const st = ctx.dom.createElement("div");
  st.className = "hk-status";
  st.dataset.state = "loading";
  st.textContent = "正在读取状态…";
  const actions = ctx.dom.createElement("div");
  actions.className = "hk-actions";
  box.append(hd, picker, st, actions);
  root.append(style, box);

  if (!api) {
    st.dataset.state = "error";
    st.textContent = "当前环境没有 hook 能力通道（应只在设置页出现）。";
    return;
  }

  // 四选一的清单来自宿主的 status().options（含还没接线的槽位），界面自己不养一份名单 ——
  // 名单与注册表漂移的表现是「点了一个宿主不认识的 Agent」，那比少一个按钮难查得多。
  let options = [];
  let current = "";
  // 上一次 set/install 带回的提示与自检结果；跟着 render 走，避免刷新一次就丢
  let lastHint = null;
  let lastCheck = null;
  let pendingSwitch = null;

  // 只用这份 widget 已经在用的那几种 DOM 动作：createElement / className / dataset /
  // textContent / on / append / replaceChildren(带节点)。零参的 replaceChildren 与
  // setAttribute("aria-pressed") / .disabled= 都不在其中 —— 上一版在这里冻结了整块面板：
  // 安装真的落盘了，面板却永远停在「正在读取状态…」。
  const paintPicker = () => {
    const nodes = [];
    for (const opt of options) {
      const b = ctx.dom.createElement("button");
      b.type = "button";
      b.className = opt.wired ? `hk-agent hk-agent-${opt.id}` : `hk-agent hk-agent-${opt.id} off`;
      b.dataset.agent = opt.id;
      b.dataset.pressed = String(opt.id === current);
      b.textContent = opt.wired ? opt.displayName : `${opt.displayName}（未接线）`;
      if (opt.wired) b.on("click", () => void switchTo(opt.id));
      nodes.push(b);
    }
    if (nodes.length > 0) picker.replaceChildren(...nodes);
  };

  // 渲染只有一个口径：宿主的 status() 快照。外部值（路径/exe/error/日志原文）一律 textContent，不拼 HTML
  const render = (info) => {
    const files = Array.isArray(info?.files) ? info.files : [];
    const lines = [];
    options = Array.isArray(info?.options) ? info.options : [];
    current = String(info?.agent ?? "");
    if (info?.hint) lastHint = String(info.hint);
    const name = String(info?.displayName ?? current ?? "");
    if (files.length === 0) {
      st.dataset.state = "absent";
      lines.push(`未安装：没找到 ${name} 的配置目录。`);
    } else if (info.installed === true) {
      st.dataset.state = "installed";
      lines.push(`已安装（${name}）：每个文件 ${info.expectedPerFile} 个事件，共 ${info.managed} 条。`);
    } else if (Number(info.managed) > 0) {
      st.dataset.state = "repair";
      lines.push(`需要修复（条数不对，${name}）：当前共 ${info.managed} 条，应为 ${files.length * info.expectedPerFile} 条。`);
    } else {
      st.dataset.state = "absent";
      lines.push(`${name}：未安装。`);
    }
    for (const f of files) lines.push(`· ${f.path} — ${f.error ? `失败：${f.error}` : `${f.managed} 条`}`);
    if (info.exe) lines.push(`hook 命令指向 ${info.exe}`);
    if (lastHint) lines.push(`生效条件：${lastHint}`);
    if (lastCheck) lines.push(lastCheck);
    // 面板文本先落地，四选一后画：清单万一为空或形状不对，也不该把状态回显一起冻住
    st.textContent = lines.join("\n");
    st.classList.toggle("warn", st.dataset.state === "repair");
    st.classList.toggle("bad", Boolean(lastCheck) && lastCheck.startsWith("自检"));
    paintPicker();
  };

  const refresh = async () => {
    try {
      render(await api.status());
    } catch (err) {
      st.dataset.state = "error";
      st.textContent = `读取状态失败：${err instanceof Error ? err.message : String(err)}`;
    }
  };
  const run = async (label, fn) => {
    hideConsent();
    st.dataset.state = "loading";
    st.textContent = `${label}中…`;
    try {
      const result = await fn();
      // install/uninstall/set 的返回里带 hint 与 selfCheck：先记下再拉 status 重渲染
      // （条数与状态一律以宿主的 status() 为准，界面不缓存自己算的数）
      if (result && typeof result === "object") {
        if (result.hint) lastHint = String(result.hint);
        lastCheck = describeCheck(result.selfCheck);
      }
      await refresh();
    } catch (err) {
      st.dataset.state = "error";
      st.textContent = `${label}失败：${err instanceof Error ? err.message : String(err)}`;
    }
  };

  // 装后自检的三种结果要说人话，尤其「没查」不能被显示成「查过且没问题」
  const describeCheck = (raw) => {
    if (!raw || typeof raw !== "object") return null;
    if (raw.status === "problem") return `自检发现问题：${raw.detail}\n日志原文：${raw.line}`;
    if (raw.status === "unavailable") return `自检未做：${raw.detail}`;
    if (raw.status === "ok") return `自检通过：${raw.detail}`;
    return null;
  };

  // 切换 = 先卸旧再装新，全部由宿主做（见 ADR-0002）。第一趟不带 confirm：
  // 需要用户拍板时宿主会原样拒掉并说明会连带启用几条，我们把那句话显示出来再问一次。
  const switchTo = async (id, confirm = false) => {
    hideConsent();
    st.dataset.state = "loading";
    st.textContent = `切换到 ${id}…`;
    try {
      const result = await api.set(id, confirm);
      lastHint = result?.hint ?? null;
      lastCheck = describeCheck(result?.selfCheck);
      await refresh();
    } catch (err) {
      // 错误经过 Worker 通道后不一定是 Error 实例，取 message 也要兜住裸字符串
      const raw = String(err?.message ?? err ?? "");
      // 判「要不要问用户」只看那个 ASCII 前缀（契约与单测见 linkage::NEED_CONFIRM）：
      // 上一版在这里匹配中文字串，结果 runner 上点了没反应 —— 猜错的表现是把一次真失败
      // 显示成确认框，或者反过来把确认框显示成失败。
      if (raw.startsWith("[need-confirm]")) {
        st.dataset.state = "consent";
        st.textContent = `${raw.slice("[need-confirm]".length).trim()}\n（当前选中未变；「仍要打开」才会动手）`;
        showConsent(id);
        return;
      }
      st.dataset.state = "error";
      // 这里**不**再 refresh 一次：切换失败可能只动了旧的一半，而刷新会把这句原因从面板上
      // 抹掉，症状正是「面板说一切正常、磁盘上一半没摘」。要现状用户自己按「刷新」。
      st.textContent = `切换失败：${raw}\n（联动可能停在中间状态，按「刷新」看磁盘上的实情）`;
    }
  };

  // 确认按钮只在「宿主第一趟拒绝、等用户拍板」时出现：槽位常驻，靠 class 显隐
  // （不动态增删节点：反复问不该把动作区堆成一排按钮，也不用零参 replaceChildren）
  const consentSlot = ctx.dom.createElement("div");
  consentSlot.className = "hk-consent-slot";
  const consentBtn = ctx.dom.createElement("button");
  consentBtn.type = "button";
  consentBtn.className = "hk-consent";
  consentBtn.textContent = "仍要打开";
  consentBtn.on("click", () => {
    if (pendingSwitch) void switchTo(pendingSwitch, true);
  });
  consentSlot.append(consentBtn);
  box.append(consentSlot);
  const showConsent = (id) => {
    pendingSwitch = id;
    consentSlot.className = "hk-consent-slot on";
  };
  const hideConsent = () => {
    pendingSwitch = null;
    consentSlot.className = "hk-consent-slot";
  };

  const button = (text, cls, fn) => {
    const b = ctx.dom.createElement("button");
    b.type = "button";
    b.className = cls;
    b.textContent = text;
    b.on("click", () => void fn());
    return b;
  };
  actions.append(
    button("安装", "hk-install", () => run("安装", () => api.install())),
    button("卸载", "hk-uninstall", () => run("卸载", () => api.uninstall())),
    button("刷新", "hk-refresh", () => refresh()),
  );

  // 挂载即拉回显：不先渲染模板默认值、也不缓存自己算的数（PLUGIN_SDK §5 第 3 条）
  void refresh();
}
