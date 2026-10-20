/**
 * 常驻状态行的文案与节流（A04 / A9b）。
 *
 * 这里只放**纯函数**：不碰 bridge、不读能力、不看时钟 —— 判「一行字该长什么样」和
 * 「两次调用之间怎么合并」是能在不开窗口的情况下逐档钉死的，留在 index.js 里就只能靠运行时猜。
 *
 * 两条约束的来源：
 * * 输入侧上限 20 是宿主的事实（`bridge.ts` 的 `STATUS_MAX_CHARS`，按**码点**取前 N 个，
 *   清洗后为空会 reject），所以宁可整段丢掉步数，也不能把 Agent 名或状态标签裁成半个词 ——
 *   裁出来的是看不懂的词，比少一个信息差得多。
 * * 「状态变化立刻让人看到」与「B3 建议两次调用间隔 ≥1s」是拉扯的：本模块取的是
 *   **状态翻转（`immediate`）无条件立刻发**，其余变化（同一状态下步数在涨）落在 1 秒窗口内
 *   **合并成最后一次**、到点发出。所以「A→B→A 来回翻转 + 中间几十次步数变化」发的是翻转那几下，
 *   不是每次工具调用一下。
 */

/** 宿主输入侧的码点上限（与 bridge.ts 的 STATUS_MAX_CHARS 同值；这里不 import 宿主，插件是不能依赖宿主模块的） */
export const MAX_CODEPOINTS = 20;

/** 分隔符。它占 3 个码点 —— 步数后缀能不能塞进去，差的就是这 3 个 */
const SEP = " · ";

/** 「窗口里没有待发的值」的哨兵：不能用 `null`，`null` 在这里是合法值（把这一行清掉） */
const NOTHING = Symbol("no-pending");

function defaultSchedule(fn, ms) {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
}

/** 按码点数，不用 `String.length`（后者对 emoji / 代理对是 2，宿主按码点裁，两者会算劈） */
export function codepoints(text) {
  let n = 0;
  for (const _ch of String(text ?? "")) n += 1;
  return n;
}

/**
 * 组一行常驻状态文本。
 *
 * @param {{agent?: string, label?: string, steps?: number}} view
 * @returns {string|null} 没有可显示的状态标签时给 `null`（调用方据此清自己那条）
 */
export function statusLine({ agent = "", label = "", steps = 0 } = {}) {
  if (!label) return null;
  const head = agent ? `${agent}${SEP}${label}` : label;
  // 名 + 标签本身就超限时：只留标签。这不是美化 —— 截断会把 Agent 名切成看不懂的半截
  const base = codepoints(head) <= MAX_CODEPOINTS ? head : label;
  if (typeof steps !== "number" || steps <= 0) return base;
  const withSteps = `${base}${SEP}${steps}步`;
  return codepoints(withSteps) <= MAX_CODEPOINTS ? withSteps : base;
}

/**
 * 节流器：`now()`、`schedule()` 与 `send()` 都从外面给 —— 判「窗口内怎么合并、延迟算得对不对」
 * 用的是手动时钟 + 手动到点，不靠 sleep（sleep 出来的绿只证明机器没卡）。
 *
 * @param {{now: () => number, send: (text: string|null) => void, gapMs?: number,
 *   schedule?: (fn: () => void, ms: number) => (() => void)}} deps
 */
export function createStatusPacer({ now, send, gapMs = 1000, schedule = defaultSchedule }) {
  let lastSentAt = -Infinity;
  let lastSent = null;
  // 用哨兵而不是 null：`null` 是合法值（「把这一行清掉」），拿它当「没有待发的」会让收尾那次清除被吞掉
  /** @type {string | null | typeof NOTHING} */
  let pending = NOTHING;
  let cancelTimer = null;
  const cancel = () => {
    if (cancelTimer) {
      cancelTimer();
      cancelTimer = null;
    }
  };

  const emit = (text) => {
    lastSent = text;
    lastSentAt = now();
    send(text);
  };

  return {
    /**
     * @param {string|null} text
     * @param {{immediate?: boolean}} [opt] `immediate: true` = 状态翻转，窗口再短也要立刻发
     *   （PM 口径：状态变化必须立即调用并带最新步数）；步数在涨而状态没变就是默认的合并。
     */
    set(text, { immediate = false } = {}) {
      // 与上一次**实际发出**的内容相同就不算变化：既不去戳宿主，也不会把 1 秒窗口重新拉长
      if (text === lastSent) return;
      if (immediate || now() - lastSentAt >= gapMs) {
        cancel();
        pending = NOTHING;
        emit(text);
        return;
      }
      // 落在窗口里：记下最新值，等到「上次发出 + gap」那一刻只发这一次
      pending = text;
      if (!cancelTimer) {
        const delay = Math.max(0, gapMs - (now() - lastSentAt));
        cancelTimer = schedule(() => {
          cancelTimer = null;
          const next = pending;
          pending = NOTHING;
          if (next !== NOTHING && next !== lastSent) emit(next);
        }, delay);
      }
    },
    /** 插件停用：丢掉没发出去的尾巴，别在停用之后再戳一次宿主 */
    stop() {
      cancel();
      pending = NOTHING;
    },
  };
}
