// 分节：自选列表与阈值（表格 + 两步清空），以及这份表格的两种回灌：
//   render(d)   —— 写 tbody（行高亮跟着 state.lastPanel）
//   autoPick(d) —— 首次进页面自动选中第一只（只做一次，别每轮回显都打一次接口）
// 装配关系不在这里：views/settings.js 按顺序挂分节并决定两者的调用次序，跨节共享只走 state。

import { TOPIC_CMD } from "../../topics.js";
import { button, cell, fmtPct, fmtPrice, input, tag, text, toneOf } from "../dom.js";

const HEADS = ["名称", "现价 / 涨跌", "涨到", "跌到", "±%", "停", ""];

/** 阈值输入框：数值回显，空着表示未设（`typeof value === "number"` 的判定不动，字符串一律当没给） */
const numCell = (dom, value, placeholder) => {
  const box = input(dom, "text", "num");
  box.placeholder = placeholder;
  box.value = typeof value === "number" ? String(value) : "";
  // Worker 里 value 只随 input/change 快照回推（widget-renderer.ts:236-249 的 listen 判定 + :88-96 的 snapshotOf），
  // click 的快照不带 value —— 不订阅 input，「存」读到的就永远是上面那次回显的初值。
  box.on("input", () => {
    // 无副作用：不复制 value、不写状态，需要的只是这条订阅本身（宿主由此才会把快照写回虚拟节点）。
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

  const render = (d) => {
    const list = d.watch ?? [];
    tbody.replaceChildren();
    for (const item of list) {
      const q = d.quotes?.[item.secid];
      const tr = tag(dom, "tr");

      const nameTd = tag(dom, "td");
      const nm = tag(dom, "div");
      nm.textContent = q?.name ?? item.name;
      const code = tag(dom, "div", "muted");
      code.textContent = item.code;
      nameTd.append(nm, code);

      const priceTd = tag(dom, "td", "quote");
      priceTd.append(text(dom, `${fmtPrice(q?.price)} `), text(dom, fmtPct(q?.pct), toneOf(q)));

      const upper = numCell(dom, item.upper, "涨到");
      const lower = numCell(dom, item.lower, "跌到");
      const pct = numCell(dom, item.pct, "±%");
      const save = button(dom, "存");
      save.on("click", () =>
        ctx.bus.publish(TOPIC_CMD, {
          action: "update",
          secid: item.secid,
          upper: upper.value.trim(),
          lower: lower.value.trim(),
          pct: pct.value.trim(),
        }));
      const limitBox = input(dom, "checkbox");
      limitBox.checked = item.limit !== false;
      limitBox.on("change", () =>
        ctx.bus.publish(TOPIC_CMD, { action: "update", secid: item.secid, limit: limitBox.checked }));
      const del = button(dom, "删", "danger");
      del.on("click", () => ctx.bus.publish(TOPIC_CMD, { action: "remove", secid: item.secid }));

      const ops = tag(dom, "td");
      ops.append(save, del);
      const limitTd = tag(dom, "td");
      limitTd.append(limitBox);
      tr.append(nameTd, priceTd, cell(dom, upper), cell(dom, lower), cell(dom, pct), limitTd, ops);
      // 整行可点：选中的那只就是盘面面板画的那只。输入框上点的还是输入框，不会误改选中
      tr.classList.add("pick");
      if (state.lastPanel?.secid === item.secid) tr.classList.add("sel");
      tr.on("click", () => ctx.bus.publish(TOPIC_CMD, { action: "select", secid: item.secid }));
      tbody.append(tr);
    }
    if (!list.length) {
      const tr = tag(dom, "tr");
      const td = tag(dom, "td", "muted");
      // colspan 不在渲染契约的 property / attr 表里：Worker 路线下这行是空操作，宿主管不到
      td.colSpan = 7;
      td.textContent = "还没有自选股。上面输入代码（如 600519）或名称点「搜索」即可添加。";
      tr.append(td);
      tbody.append(tr);
    }
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
