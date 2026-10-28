// 分节：自选列表与阈值（表格 + 两步清空），以及这份表格的两种回灌：
//   render(d)   —— 写 tbody（行高亮跟着 state.lastPanel）
//   autoPick(d) —— 首次进页面自动选中第一只（只做一次，别每轮回显都打一次接口）
// 装配关系不在这里：views/settings.js 按顺序挂分节并决定两者的调用次序，跨节共享只走 state。
//
// 回显口径（Bug4）：行情每 tick 推一次 d，**行节点按 secid 复用**，每帧只改文本与涨跌配色；
// 整表重建会把用户正在输入的阈值连旧节点一起冲掉。只有增删行/重排才动 tbody 的结构。
// 「正在编辑」记在本节的 editing 里：replaceChildren 之后旧虚拟节点 id 作废，
// 宿主不会替你保留值（src/runtime/widget-node.ts 的契约），锁只能在 Worker 侧自己记。

import { TOPIC_CMD } from "../../topics.js";
import { button, cell, fmtPct, fmtPrice, input, tag, text, toneOf } from "../dom.js";

const HEADS = ["名称", "现价 / 涨跌", "涨到", "跌到", "±%", "停", ""];

/** 空表时那一条占位行的 key；自选股 secid 不会是空串，用 "\u0000" 前缀避免撞名 */
const EMPTY_ROW = "\u0000empty";

/**
 * 回显一步的纯决策（G5-01）：DOM 在 Worker 里拿不到，锁的行为只能拆成纯函数钉住。
 * 结局：
 *   - force（刚点过「存」）→ 无条件按宿主的值重画一次并记台账：存进去的非法值被钳成空时，
 *     这一步就是把框里那串没生效的草稿清掉的地方；合法值时也只是把同一串写回，幂等。
 *   - 编辑中且宿主已追上用户填的串 → 放开锁、把台账记成这串、不写；
 *   - 编辑中且还没追上 → 不写，草稿留着；
 *   - 没在编辑 → 台账与目标不同才写，避免每帧重发同一个 op。
 * @param {{editing?: boolean, value?: string, want?: string, ledger?: string|null, force?: boolean}} input
 * @returns {{release: boolean, write: boolean, ledger: string}}
 */
export function echoStep({ editing = false, value = "", want = "", ledger = null, force = false } = {}) {
  // 「存」之后强制对齐一次：不信任框里的草稿，也不信任台账
  if (force) return { release: false, write: true, ledger: want };
  if (editing) {
    // 追上即放开：这时写回的就是用户自己填的那串，冲不掉任何东西
    if (value === want) return { release: true, write: false, ledger: want };
    return { release: false, write: false, ledger };
  }
  if (ledger === want) return { release: false, write: false, ledger: want };
  return { release: false, write: true, ledger: want };
}

/**
 * 点「存」要记进台账的串（G5-01）：**框里的实际值**，不是配置里的旧值。
 * 少了这一步，存进去的非法值被宿主钳成空值时，回显判定「台账已经是空串」而不写，
 * 框里就留下一串没有生效的草稿 —— 用户以为存上了，其实存的是空。
 * @param {{upper?: string, lower?: string, pct?: string}} boxes 三个输入框的当前串
 */
export function savedLedger(boxes = {}) {
  const str = (v) => String(v ?? "").trim();
  return { upper: str(boxes.upper), lower: str(boxes.lower), pctNum: str(boxes.pct) };
}

/**
 * 阈值输入框：数值回显，空着表示未设（`typeof value === "number"` 的判定不动，字符串一律当没给）
 * @param {any} dom Worker 侧的 ctx.dom
 * @param {number|null|undefined} value 配置里的数值
 * @param {string} placeholder 占位文案
 * @param {Set<any>} editing 正在输入的节点集合；`input` 事件里置位，「存」才放开
 */
const numCell = (dom, value, placeholder, editing) => {
  const box = input(dom, "text", "num");
  box.placeholder = placeholder;
  box.value = typeof value === "number" ? String(value) : "";
  // Worker 里 value 只随 input/change 快照回推（widget-renderer.ts:236-249 的 listen 判定 + :88-96 的 snapshotOf），
  // click 的快照不带 value —— 不订阅 input，「存」读到的就永远是上面那次回显的初值。
  // 订阅里只做一件事：把这条输入框记成「用户正在编辑」，回显先绕开它。
  box.on("input", () => {
    editing.add(box);
  });
  return box;
};

/**
 * 挂「自选与提醒规则」分节。
 * @param {{bus: {publish: Function}, dom: object}} ctx
 * @param {any} state 装配壳建的共享状态（用到 lastPanel / autoPicked / section，见 work/M4b/closures.md）
 * @returns {{section: HTMLElement, render: Function, autoPick: Function}}
 */
export function mountWatchList(ctx, state) {
  const dom = ctx.dom;
  const headRow = tag(dom, "tr");
  for (const label of HEADS) {
    const th = tag(dom, "th");
    th.textContent = label;
    headRow.append(th);
  }
  const thead = tag(dom, "thead");
  thead.append(headRow);
  const tbody = tag(dom, "tbody");
  const table = tag(dom, "table");
  table.append(thead, tbody);

  // 两步确认，避免误点把用户的自选与阈值一次清光
  const clearBtn = button(dom, "清空自选", "danger");
  let clearArmed = false;
  clearBtn.on("click", () => {
    if (!clearArmed) {
      clearArmed = true;
      clearBtn.textContent = "再点一次确认清空";
      setTimeout(() => {
        clearArmed = false;
        clearBtn.textContent = "清空自选";
      }, 4000);
      return;
    }
    ctx.bus.publish(TOPIC_CMD, { action: "clear" });
    clearArmed = false;
    clearBtn.textContent = "清空自选";
  });

  /** 用户碰过、而推送里的配置还没追上他所选的节点：回显先绕开（Bug4 的核心） */
  const editing = new Set();
  /** 刚点过「存」的输入框：下一帧无条件按宿主的值重画一次（G5-01 的清草稿点） */
  const forced = new Set();
  /** secid -> 这一行的节点集合。行只在增删时重建，tick 只改文本与值。 */
  const rows = new Map();
  /** tbody 当前的行序（空表时是 [EMPTY_ROW]），与想要的行序不同才走结构重排 */
  let order = [];

  /** 数值格回显：编辑中的先不动；配置追上用户填的值就放开这把锁 */
  const syncValue = (row, key, box, want) => {
    // 决策在 echoStep 里（纯函数，离线单测钉得住）：
    // 编辑中的先不动；追上即放开；没在编辑就「台账相同不写」——
    // 一是别每帧重发同一个 op，二是第一次击键的 input 还在去宿主的路上时，
    // 这一帧的回显不能把刚敲进去的字符冲掉（那与 Bug4 报的是同一件事，只是窗口更小）。
    const step = echoStep({
      editing: editing.has(box),
      value: String(box.value ?? ""),
      want,
      ledger: row.last[key],
      force: forced.delete(box),
    });
    if (step.release) editing.delete(box);
    row.last[key] = step.ledger;
    if (step.write) box.value = want;
  };

  /** 复选框回显：同一条口径（勾上就发命令，所以等配置追上即放开） */
  const syncChecked = (row, key, box, want) => {
    if (editing.has(box)) {
      if (box.checked === want) {
        editing.delete(box);
        row.last[key] = want;
      }
      return;
    }
    if (row.last[key] === want) return;
    row.last[key] = want;
    box.checked = want;
  };

  /** 建一行：节点与两个文本槽位都留在这份记录里，之后每帧只写槽位 */
  const buildRow = (item) => {
    const tr = tag(dom, "tr");
    const nameNode = tag(dom, "div");
    const codeNode = tag(dom, "div", "muted");
    const nameTd = tag(dom, "td");
    nameTd.append(nameNode, codeNode);

    const priceTd = tag(dom, "td", "quote");
    const priceNode = text(dom, "");
    const toneNode = text(dom, "");
    priceTd.append(priceNode, toneNode);

    const upper = numCell(dom, item.upper, "涨到", editing);
    const lower = numCell(dom, item.lower, "跌到", editing);
    const pct = numCell(dom, item.pct, "±%", editing);
    const save = button(dom, "存");
    const limitBox = input(dom, "checkbox");
    limitBox.on("change", () => {
      editing.add(limitBox);
      ctx.bus.publish(TOPIC_CMD, { action: "update", secid: item.secid, limit: limitBox.checked });
    });
    const del = button(dom, "删", "danger");
    del.on("click", () => ctx.bus.publish(TOPIC_CMD, { action: "remove", secid: item.secid }));

    const ops = tag(dom, "td");
    ops.append(save, del);
    const limitTd = tag(dom, "td");
    limitTd.append(limitBox);
    tr.append(nameTd, priceTd, cell(dom, upper), cell(dom, lower), cell(dom, pct), limitTd, ops);
    // 整行可点：选中的那只就是盘面面板画的那只。输入框上点的还是输入框，不会误改选中
    tr.classList.add("pick");
    tr.on("click", () => ctx.bus.publish(TOPIC_CMD, { action: "select", secid: item.secid }));
    // last* 是「上一次写出去什么」的台账：虚拟节点虽然有 getter，但台账比它更省一次跨 realm 读，
    // 而且它同时是「这一帧的值与上次相同就别写」的依据（见 syncValue）。
    // 初值取建节点时 numCell 已经写进去的那串，否则第一次回显会被台账挡住。
    const numText = (v) => (typeof v === "number" ? String(v) : "");
    const row = {
      tr,
      nameNode,
      codeNode,
      priceNode,
      toneNode,
      upper,
      lower,
      pct,
      limitBox,
      last: {
        name: null,
        code: null,
        price: null,
        toneText: null,
        tone: null,
        sel: null,
        limit: null,
        upper: numText(item.upper),
        lower: numText(item.lower),
        pctNum: numText(item.pct),
      },
    };
    save.on("click", () => {
      // 点「存」就是提交：台账改成**框里的实际串**，再把三格放开，下一轮回显写的是宿主钳过的值。
      // 台账不能留配置里的旧值：存进非法值被宿主钳成空值时，回显拿「空 === 空」判成
      // 「不用写」，框里就留着那串没生效的草稿（G5-01）。
      // 提交前不放开 —— 否则一次 tick 就把没存过的输入冲掉（Bug4 报的就是这个）。
      const saved = savedLedger({ upper: upper.value, lower: lower.value, pct: pct.value });
      for (const [key, want] of Object.entries(saved)) row.last[key] = want;
      for (const box of [upper, lower, pct]) {
        editing.delete(box);
        // 下一帧不管台账如何都按宿主的值重画：存进去的非法值这时才被清掉，
        // 也顺手把「点存时还有一帧在途」的窗口关死
        forced.add(box);
      }
      ctx.bus.publish(TOPIC_CMD, {
        action: "update",
        secid: item.secid,
        upper: saved.upper,
        lower: saved.lower,
        pct: saved.pctNum,
      });
    });
    return row;
  };

  /** 每帧回显：只写变了的那几个槽位，输入框走 syncValue / syncChecked */
  const updateRow = (row, item, q) => {
    const name = String(q?.name ?? item.name ?? "");
    if (row.last.name !== name) {
      row.nameNode.textContent = name;
      row.last.name = name;
    }
    const code = String(item.code ?? "");
    if (row.last.code !== code) {
      row.codeNode.textContent = code;
      row.last.code = code;
    }
    const price = `${fmtPrice(q?.price)} `;
    if (row.last.price !== price) {
      row.priceNode.textContent = price;
      row.last.price = price;
    }
    const pctText = fmtPct(q?.pct);
    if (row.last.toneText !== pctText) {
      row.toneNode.textContent = pctText;
      row.last.toneText = pctText;
    }
    const tone = toneOf(q);
    if (row.last.tone !== tone) {
      row.toneNode.className = tone;
      row.last.tone = tone;
    }
    syncValue(row, "upper", row.upper, typeof item.upper === "number" ? String(item.upper) : "");
    syncValue(row, "lower", row.lower, typeof item.lower === "number" ? String(item.lower) : "");
    syncValue(row, "pctNum", row.pct, typeof item.pct === "number" ? String(item.pct) : "");
    syncChecked(row, "limit", row.limitBox, item.limit !== false);
    const sel = state.lastPanel?.secid === item.secid;
    if (row.last.sel !== sel) {
      if (sel) row.tr.classList.add("sel");
      else row.tr.classList.remove("sel");
      row.last.sel = sel;
    }
  };

  /** 空表占位行：建一次留着，只在行序真的变化时进/出 tbody */
  let emptyTr = null;
  const emptyRow = () => {
    if (!emptyTr) {
      const tr = tag(dom, "tr");
      const td = tag(dom, "td", "muted");
      // colspan 不在渲染契约的 property / attr 表里：Worker 路线下这行是空操作，宿主管不到
      td.colSpan = 7;
      td.textContent = "还没有自选股。上面输入代码（如 600519）或名称点「搜索」即可添加。";
      tr.append(td);
      emptyTr = tr;
    }
    return emptyTr;
  };

  const render = (d) => {
    const list = d.watch ?? [];
    const kept = new Set(list.map((item) => item.secid));
    for (const item of list) {
      if (!rows.has(item.secid)) rows.set(item.secid, buildRow(item));
    }
    const wanted = list.length ? list.map((item) => item.secid) : [EMPTY_ROW];
    // 结构只在这一帧动：行集合或顺序变了才 replaceChildren + 重新 append。
    // 行情 tick 不改行集合，所以走不到这里 —— 这正是「输入不被冲掉」的前提。
    if (wanted.join("\u0001") !== order.join("\u0001")) {
      tbody.replaceChildren();
      for (const [id, row] of [...rows]) {
        if (!kept.has(id)) {
          // 被删的行：连节点与编辑标记一起丢，别留悬空的 Set 成员
          rows.delete(id);
          for (const node of [row.upper, row.lower, row.pct, row.limitBox]) editing.delete(node);
        }
      }
      order = wanted.slice();
      for (const id of wanted) tbody.append(id === EMPTY_ROW ? emptyRow() : rows.get(id).tr);
    }
    for (const item of list) updateRow(rows.get(item.secid), item, d.quotes?.[item.secid]);
  };

  // 一进页面就把第一只的盘面拉出来，省得先点一行才知道这块能看什么。
  // 只在本次挂载做一次，避免每轮回显都发一遍 select 去打接口。
  const autoPick = (d) => {
    const list = d.watch ?? [];
    if (!state.autoPicked && list.length && !state.lastPanel?.secid) {
      state.autoPicked = true;
      ctx.bus.publish(TOPIC_CMD, { action: "select", secid: list[0].secid });
    }
  };

  return { section: state.section("自选与提醒规则", table, clearBtn), render, autoPick };
}
