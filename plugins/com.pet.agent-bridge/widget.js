// 状态显示的两个区（A9b 之后没有第三区了）：
//   badge   = 宠物旁的一行小字
//   settings= 设置窗里的 Agent 五选一与接入/断开（ctx.host 只注入给这个区）
// 「接入」有两种形态，由宿主 status() 的 `mode` 区分：hook（往配置文件装条目）与
// bridge（DSH：桥是 DSH 侧插件，宠物这边没有文件可装，只校验装没装）。
// 会话状态的「桌面可见」那一层已经交给本体气泡的常驻行（`ctx.pet.setStatus`，宿主侧是 B3）：
// 头顶那张 overlay 大卡删了，插件也不再申请 overlay 能力。
// 所有数据来自 `${PID}:widget` topic，而 topic 里根本没有会话标题与命令摘要 ——
// index.js 不采集它们，这里拿不到也就无从显示，不存在「渲染后再藏起来」的漏洞。
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
  if (ctx.region === "settings") return mountSettings(root, ctx);
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
    // A9b 之后 payload 里没有 title / detail 这两个字段了（不采集），空态判据只看这三项
    const idleEmpty = (d.state ?? "idle") === "idle" && steps === 0 && !d.toolName;
    if (idleEmpty) {
      el.remove();
      return;
    }
    dot.style.background = STATE_COLOR[d.state] ?? "#9aa4b2";
    text.textContent = `${d.label ?? d.state ?? "待命"}${d.steps ? ` · ${d.steps} 步` : ""}`;
    root.append(el);
  });
}

/* ---------- 设置面板 ---------- */
function mountSettings(root, ctx) {
  const style = ctx.dom.createElement("style");
  style.textContent = `
    .ag-set { font-size:12px; color:#475467; display:grid; gap:6px; }
    .ag-set .note { color:#98a2b3; font-size:11px; }
  `;
  const box = ctx.dom.createElement("div");
  box.className = "ag-set";
  // A9b：隐私开关（显示会话标题 / 命令摘要）撤掉了 —— 常驻行一直可见、不受它们控制，
  // 留着就是骗人；而且 index.js 现在根本不采集那两个字段。
  const note = ctx.dom.createElement("div");
  note.className = "note";
  note.textContent = "会话状态显示在本体气泡的常驻状态行上（只显示 Agent、状态与步数，不含会话标题与命令内容）。";
  box.append(note);
  root.append(style, box);
  // 面板挂载即向入口 realm 要一次当前值（宿主 `*:widget` 的回灌是双保险），
  // 并把宿主给的显示名交出去 —— 入口 realm 没有 ctx.host，只有这里拿得到 displayName。
  const sendSync = (displayName) => ctx.bus.publish(TOPIC_CMD, { action: "sync", displayName });
  // 面板是新建的、会话早就在跑：开口要一次当前值，否则 badge 会显示成默认态
  sendSync();

  // Agent hook 的装/卸与五选一（B2 把宿主那张卡片删掉后，这里就是唯一入口）。
  // 宿主 status() 给的 displayName 顺带交给入口 realm —— 常驻行要显示 Agent 名，
  // 而入口 realm 没有 ctx.host，只有这个区拿得到它，插件里因此不留第二份名字表。
  mountHookPanel(root, ctx, (displayName) => sendSync(displayName));
}


/* ---------- 设置面板：Agent hook 接入（settings 区专属能力 agent:hooks，见 ADR-0001） ---------- */
function mountHookPanel(root, ctx, reportName) {
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
  hd.textContent = "Agent 接入（同一时间只联动一个）";
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

  // 五选一的清单来自宿主的 status().options（含还没接线的槽位），界面自己不养一份名单 ——
  // 名单与注册表漂移的表现是「点了一个宿主不认识的 Agent」，那比少一个按钮难查得多。
  let options = [];
  let current = "";
  // 当前这家的接入形态（宿主给）：hook = 配置文件装条目，bridge = DSH 的插件桥。
  /** @type {"hook" | "bridge"} */
  let currentMode = "hook";
  // 上一次 set/install 带回的提示与自检结果；跟着 render 走，避免刷新一次就丢
  let lastHint = null;
  let lastCheck = null;
  let pendingSwitch = null;
  // 动作区的两个文案随形态变（hook：安装/卸载；bridge：接入/断开）。
  // 按钮节点在下面才建，这里先占位，避免 render 引用到还没初始化的 const。
  /** @type {(mode: "hook" | "bridge") => void} */
  let paintActions = () => {};

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
      if (opt.wired)
        b.on("click", () => {
          // 最早断点的探针：监听到底有没有被调到。runner 上「点了没反应」有三种可能
          // （监听没注册 / 调了 switchTo 但宿主调用失败 / 失败后被别的渲染覆盖），
          // 没有这个标记就只能靠猜；面板原文 + 这个标记一次就能分开。
          st.dataset.lastSwitch = opt.id;
          void switchTo(opt.id);
        });
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
    // 常驻行的 Agent 名只认宿主给的这一个来源：入口 realm 没有 ctx.host，拿不到 displayName，
    // 插件里再养一份「id → 名字」表迟早和宿主漂移。
    if (name) reportName?.(name);
    currentMode = info?.mode === "bridge" ? "bridge" : "hook";
    const bridge = info?.bridge ?? null;
    if (currentMode === "bridge") {
      // DSH 没有配置文本可数，判据换成「桥插件在不在 profile 的 bundles 清单里」
      if (info?.installed === true) {
        st.dataset.state = "installed";
        lines.push(`已接入（${name}）：桥插件挂在 ${Number(bridge?.profiles) || 0} 个 profile 上。`);
      } else {
        st.dataset.state = "absent";
        lines.push(`未接入（${name}）：它没有 hook 文件可装，桥是 DSH 侧的插件。`);
      }
      if (bridge?.bundleDir) lines.push(`桥目录：${bridge.bundleDir}`);
      if (bridge?.dshHome) lines.push(`DSH 数据目录：${bridge.dshHome}`);
      if (info?.installed !== true)
        lines.push("安装方法：在 DSH 里让它调用 plugin_manager（action=install_bundle），target 填上面的桥目录。");
    } else if (files.length === 0) {
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
    // 「hook 命令指向 …」只对文件形态有意义：桥形态下这些条目根本不存在
    if (currentMode !== "bridge" && info.exe) lines.push(`hook 命令指向 ${info.exe}`);
    if (lastHint) lines.push(`生效条件：${lastHint}`);
    if (lastCheck) lines.push(lastCheck);
    // 面板文本先落地，四选一后画：清单万一为空或形状不对，也不该把状态回显一起冻住
    st.textContent = lines.join("\n");
    st.classList.toggle("warn", st.dataset.state === "repair");
    st.classList.toggle("bad", Boolean(lastCheck) && lastCheck.startsWith("自检"));
    paintActions(currentMode);
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
  // 两种接入形态的动作是同一对按钮，只是叫法不同：DSH 没有「安装文件」这回事
  const words = () =>
    currentMode === "bridge"
      ? { install: "接入", uninstall: "断开" }
      : { install: "安装", uninstall: "卸载" };
  const installBtn = button("安装", "hk-install", () => run(words().install, () => api.install()));
  const uninstallBtn = button("卸载", "hk-uninstall", () => run(words().uninstall, () => api.uninstall()));
  actions.append(installBtn, uninstallBtn, button("刷新", "hk-refresh", () => refresh()));
  paintActions = (mode) => {
    installBtn.textContent = mode === "bridge" ? "接入" : "安装";
    uninstallBtn.textContent = mode === "bridge" ? "断开" : "卸载";
  };
  paintActions(currentMode);

  // 挂载即拉回显：不先渲染模板默认值、也不缓存自己算的数（PLUGIN_SDK §5 第 3 条）
  void refresh();
}
