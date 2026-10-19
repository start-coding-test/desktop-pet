// Agent 桥：把编码 Agent 的会话状态映射成宠物反应，并往本体气泡挂一行常驻状态行。
//
// 数据源是宿主广播的 agent:state / agent:event —— Qoder hook 事件由 Rust 侧
// （services/agent.rs）落盘、归一化后注入总线。本插件只是表现层：
// 不碰 hook 配置，不读写用户目录，也不发任何网络请求。
//
// A9b（本文件现在的形态）：头顶那张 overlay 状态卡删了，会话状态改由 `ctx.pet.setStatus`
// 挂到本体气泡的常驻行上（ADR-0010 决策 6 的插件侧部分，B3 提供宿主接口）。
//
// 隐私口径：会话标题与命令摘要**根本不进这一层** —— 以前是「开关关着就剥掉」，
// 现在是没有那条分支：常驻行一直可见、不受任何开关控制，所以采集它们本身就是泄漏面。
// 老用户存储里那份 `config`（showTitle/showDetail）于是失去对象，我们既不读也不写、
// 更不删（升级不动用户配置），设置页里对应的两个开关一并撤掉。
import { TOPIC_CMD, TOPIC_STATE, TOPIC_STATUS } from "./topics.js";
import { createStatusPacer, statusLine } from "./status-line.js";

// 宿主会话状态 → 宠物状态。词表就是 petdex 的九个状态，映射也照搬 petdex
// （packages/petdex-cli/src/hooks/bubble-runner.ts 的 stateForEvent）：
// 进行中=running、等确认=waiting、一轮结束=waving。
// 细粒度事件再按 phase 覆盖（见 stateForPhase），因为 petdex 的动画粒度本来就在工具调用这一层。
const ACTION_BY_STATE = {
  running: "running",
  needs_input: "waiting",
  completed: "waving",
  idle: "idle",
};

// petdex 把只读工具（Read|Grep|Glob）单独归到 review（「专注查看/思考」循环），其余工具算 running
const READ_ONLY_TOOLS = new Set(["read", "grep", "glob"]);

/** phase → petdex 状态。返回 null 表示这次事件不改变姿势 */
function stateForPhase(phase, toolName) {
  switch (phase) {
    case "pre": {
      const lower = (toolName || "").toLowerCase();
      return READ_ONLY_TOOLS.has(lower) ? "review" : "running";
    }
    case "subagent-start":
      return "running";
    case "user-prompt":
    case "session-start":
      return "jumping";
    case "tool-failure":
    case "stop-failure":
      return "failed";
    case "stop":
      return "waving";
    case "approval-request":
    case "notification":
      return "waiting";
    case "post":
    case "subagent-stop":
    case "session-end":
      return "idle";
    default:
      return null;
  }
}

/** 一轮结束后常驻行再留多久（毫秒）：B3 的台词与常驻行共用一个槽，台词显完会回位到这条 */
const HIDE_AFTER_DONE_MS = 3000;

/** 一次性台词（`pet.say`）。它和常驻行是两回事：台词说完就没了，常驻行一直在那 */
function lineFor(state, tool) {
  if (state === "needs_input") return "这边需要你确认一下";
  if (state === "completed") return "刚才那轮跑完了";
  if (state === "failed") return tool ? `${tool} 失败了，回去看看` : "有一步失败了，回去看看";
  return null;
}

const LABEL = {
  running: "正在执行",
  needs_input: "等你确认",
  completed: "这轮完成",
  // failed 以前只有一句台词（lineFor），没有标签：常驻行得有个词可显示（A9b 补）
  failed: "这步失败",
  idle: "待命",
};

let ctx = null;
let lastState = null;
let lastTool = null;
let seenCounter = -1;
let hideTimer = 0;
let latest = { state: "idle", steps: 0, toolName: "" };
/** 常驻行上的 Agent 名：优先用设置页给的显示名，没开过设置页就退回宿主事件里的那个 id */
let agentName = "";
/** 节流器在 activate 里建（它要闭包到 ctx）；停用时丢掉没发出的尾巴 */
let pacer = null;

function status(text, level = "info") {
  ctx?.bus.publish(TOPIC_STATUS, { text, level });
}

/** widget（badge / 设置页）能看到的就这些：没有标题、没有命令摘要 */
function publicView() {
  return {
    state: latest.state,
    label: LABEL[latest.state] ?? latest.state,
    steps: latest.steps,
    toolName: latest.toolName,
    agentName,
  };
}

function push() {
  ctx?.widget.update(publicView());
}

/** 当前那行字：`idle` 就是「没有会话」，交 `null` 清掉自己那条（宿主不允许用空串清） */
function currentLine() {
  if (latest.state === "idle") return null;
  return statusLine({
    agent: agentName,
    label: LABEL[latest.state] ?? latest.state,
    steps: latest.steps,
  });
}

async function pushStatusLine(text) {
  try {
    await ctx?.pet.setStatus(text);
  } catch (err) {
    // 失败不重试也不刷屏：这一行看不见，远好过为它把事件链卡住
    ctx?.log?.("常驻状态行设置失败", err);
  }
}

function syncStatus({ immediate = false } = {}) {
  pacer?.set(currentLine(), { immediate });
}

/** 一轮跑完后常驻行再留 3 秒（让人看清「这轮完成」），然后回到无会话状态把它清掉 */
function scheduleHide() {
  cancelHide();
  hideTimer = setTimeout(() => {
    hideTimer = 0;
    latest = { ...latest, state: "idle" };
    push();
    syncStatus({ immediate: true });
  }, HIDE_AFTER_DONE_MS);
}

function cancelHide() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = 0;
  }
}

async function onState(payload) {
  const state = typeof payload?.state === "string" ? payload.state : null;
  if (!state) return;
  if (typeof payload.counter === "number") {
    if (payload.counter <= seenCounter) return;
    seenCounter = payload.counter;
  } else if (state === lastState) {
    return;
  }
  lastState = state;
  if (typeof payload.agent === "string" && payload.agent) agentName = payload.agent;
  // 注意：payload 里的 title 这里**不接**（A9b 起本插件不再持有会话标题）
  latest = {
    ...latest,
    state,
    steps: typeof payload.steps === "number" ? payload.steps : latest.steps,
  };
  ctx.bus.publish(TOPIC_STATE, { state, counter: payload.counter ?? null });
  if (state === "completed") scheduleHide();
  else cancelHide();
  push();
  // 总状态翻转是「用户该立刻看到」的那种变化
  syncStatus({ immediate: true });

  const action = ACTION_BY_STATE[state];
  if (!action) return;
  await ctx.pet.react(action);
  const line = lineFor(state, null);
  if (line) await ctx.pet.say(line);
}

/** 还没拿到过总状态时，从事件 phase 推一个常驻行用的状态（不影响宠物动作） */
function stateFromPhase(phase) {
  if (phase === "approval-request") return "needs_input";
  if (phase === "stop") return "completed";
  if (phase === "session-end") return "idle";
  if (["user-prompt", "session-start", "pre", "post", "subagent-start", "subagent-stop", "tool-failure", "stop-failure"].includes(phase)) {
    return "running";
  }
  return null;
}

async function onEvent(payload) {
  const phase = typeof payload?.phase === "string" ? payload.phase : "";
  const tool = typeof payload?.toolName === "string" ? payload.toolName.slice(0, 40) : "";
  if (phase === "tool-failure" || phase === "stop-failure") lastTool = tool || lastTool;
  if (typeof payload?.agent === "string" && payload.agent) agentName = payload.agent;
  // 命令摘要 / 会话标题不在这里落地：它们连本插件都不进（A9b）
  latest = {
    ...latest,
    toolName: tool || latest.toolName,
    steps: typeof payload?.steps === "number" ? payload.steps : latest.steps,
  };
  if (seenCounter < 0) {
    // 插件是在会话进行中才被启用的话，总状态下一条可能永远不来（宿主只在变化时广播）
    const derived = stateFromPhase(phase);
    if (derived && derived !== latest.state) {
      latest = { ...latest, state: derived };
      if (derived === "completed") scheduleHide();
      else cancelHide();
      syncStatus({ immediate: true });
    }
  }
  push(); // 常驻行要跟着每一次工具调用走（步数在涨），而不是只跟着状态翻转走
  // 同状态下的步数变化走合并（状态没翻，不配打断 1 秒窗口）
  syncStatus();

  const next = stateForPhase(phase, tool);
  // 工具收尾（post/subagent-stop）时若总状态仍是 running，就不把姿势打回 idle。
  // petdex 桌面端只有一个 /state 通道、post 确实回 idle；但这里工具是连续调用的，
  // 照搬会让宠物在两次调用之间闪一下 idle。一轮真正结束由 stop → waving 表达。
  if (!next || (next === "idle" && lastState === "running")) return;
  try {
    await ctx?.pet.react(next);
  } catch {
    /* 已停用 */
  }
  if (next === "failed") {
    try {
      await ctx?.pet.say(lineFor("failed", lastTool));
    } catch {
      /* 已停用 */
    }
  }
}

async function handleCmd(cmd) {
  // A9b 之后设置页只剩「四选一 + 装卸」，隐私开关连同 `config` 命令一并撤了
  if (cmd?.action !== "sync") return;
  // 面板重新挂载时主动要一份当前数据（宿主的 `*:widget` 回灌是双保险）。
  // 显示名只有设置页那条通道拿得到（宿主 status()），入口 realm 没有 ctx.host，
  // 所以这里收一次：没收到过就用事件里的 agent id 原样，不在插件里另立一份名字表。
  if (typeof cmd.displayName === "string" && cmd.displayName) {
    agentName = cmd.displayName;
    // 名字是这一行的开头：换了就该立刻看见，不排队
    syncStatus({ immediate: true });
  }
  push();
}

export async function activate(context) {
  stop();
  ctx = context;
  lastState = null;
  lastTool = null;
  seenCounter = -1;
  agentName = "";
  latest = { state: "idle", steps: 0, toolName: "" };
  pacer = createStatusPacer({ now: () => Date.now(), send: (text) => void pushStatusLine(text) });

  // A9b：这里**不读**存储里那份旧 `config`（showTitle/showDetail）。设置页已经没有那两个开关，
  // 读回来也没有消费者；主动删它等于升级时动用户的配置。判据钉的是「前后字节一致」。

  ctx.bus.subscribe("agent:state", (p) => void onState(p));
  ctx.bus.subscribe("agent:event", (p) => void onEvent(p));
  ctx.bus.subscribe(TOPIC_CMD, (p) => void handleCmd(p));
  push();
  status("已接管宿主 Agent 事件");
}

function stop() {
  // 总线订阅由宿主在插件停用时统一回收（见 src/runtime/subscriptions.ts）；
  // 这里只管自己的定时器与没发出去的常驻行尾巴。
  cancelHide();
  pacer?.stop();
}

export async function deactivate() {
  const c = ctx;
  stop();
  pacer = null;
  try {
    // 停用就是把我们这一行摘掉；总线回收之后不会再有事件进来。
    // 宿主另有一条 5 秒兜底（下线回收），那句判据在 B3 的套件里。
    await c?.pet.setStatus(null);
  } catch {
    /* 已停用 */
  }
  ctx = null;
}
