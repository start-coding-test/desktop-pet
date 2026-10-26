// 分节：添加自选（关键字搜索候选 + 直接按代码添加）。
// 装配关系不在这里：views/settings.js 按顺序挂分节，跨节共享只走 state 与 ./util.js。

import { TOPIC_CMD } from "../../topics.js";
import { button, input, tag, text } from "../dom.js";

/**
 * 挂「添加自选」分节。
 * @param {{bus: {publish: Function}, dom: object}} ctx 插件上下文（用 bus 与 ctx.dom 建节点）
 * @param {any} state 装配壳建的共享状态（字段清单见 work/M4b/closures.md）
 * @returns {{section: HTMLElement, setSuggestions: (rows: unknown[]) => number}}
 *   `setSuggestions` 返回候选条数，供壳里的订阅写状态行（原来是在同处读 `suggestions.length`）。
 */
export function mountAdd(ctx, state) {
  const dom = ctx.dom;
  const addInput = input(dom, "text");
  addInput.placeholder = "代码或名称，例如 600519 / 茅台";
  addInput.style.flex = "1";
  addInput.style.minWidth = "170px";
  const searchBtn = button(dom, "搜索");
  const addBtn = button(dom, "直接添加", "primary");
  const sugBox = tag(dom, "div", "sug");
  let suggestions = [];

  const renderSug = () => {
    sugBox.replaceChildren();
    for (const row of suggestions) {
      const item = tag(dom, "div", "item");
      const add = button(dom, "添加");
      add.on("click", () => {
        ctx.bus.publish(TOPIC_CMD, { action: "add", secid: row.secid, code: row.code, name: row.name });
        suggestions = suggestions.filter((s) => s.secid !== row.secid);
        renderSug();
      });
      item.append(text(dom, `${row.name}（${row.code}${row.type ? ` · ${row.type}` : ""}）`), add);
      sugBox.append(item);
    }
  };

  /** 「直接添加」的提交：按钮点击与输入框回车共用（虚拟节点上没有 .click() 可调） */
  const submitAdd = () => {
    const v = addInput.value.trim();
    if (!v) return state.status.set("先输入 6 位代码", "error");
    ctx.bus.publish(TOPIC_CMD, { action: "add", input: v });
    addInput.value = "";
  };
  searchBtn.on("click", () => {
    const kw = addInput.value.trim();
    if (!kw) return state.status.set("先输入代码或名称关键字", "error");
    state.status.set(`正在搜索「${kw}」…`);
    ctx.bus.publish(TOPIC_CMD, { action: "search", keyword: kw });
  });
  addBtn.on("click", submitAdd);
  // Worker 的 value 只随 input/change 快照回推；keydown 快照只带 key。
  // 订阅 input 让宿主把每次输入的值写回虚拟节点（真正的写回在 widget-node.handleEvent）。
  addInput.on("input", () => {
    // 不复制 value、不写状态；这里只需要一个 input 监听让宿主转发快照。
  });
  // 回车原来走 addBtn.click() 并当场 preventDefault：契约里 preventDefault 只能订阅时整键声明
  //（会拦掉全部按键），而这个输入框不在表单里、回车本无默认动作，所以只保留「回车=提交」
  addInput.on("keydown", (e) => {
    if (e.key === "Enter") submitAdd();
  });

  const row = tag(dom, "div", "row");
  row.append(addInput, searchBtn, addBtn);

  return {
    section: state.section("添加自选股", row, sugBox),
    setSuggestions: (rows) => {
      suggestions = rows;
      renderSug();
      return suggestions.length;
    },
  };
}
