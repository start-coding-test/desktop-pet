// 首次连接 / 更换 Key / 演示数据。完整 Key 只经 :cmd 上行，界面只拿到掩码。
import { TOPIC_CMD } from "../../topics.js";
import { button, card, hint, input, row, text } from "../dom.js";

export function mountOnboarding(ctx, state) {
  const dom = ctx.dom;
  const box = card(dom, "连接 Command Code");
  const key = input(dom, "password", "g-input");
  key.dataset.field = "apiKey";
  key.placeholder = "粘贴 Command Code API Key";
  let editing = false;
  key.on("input", () => {
    editing = true;
  });

  const testBtn = button(dom, "测试连接", "g-btn");
  const saveBtn = button(dom, "保存", "g-btn primary");
  const clearBtn = button(dom, "清除 Key", "g-btn");
  const demoBtn = button(dom, "演示数据", "g-btn");
  const masked = text(dom, "未配置 Key", "g-muted");
  const note = hint(dom, "凭据保存在本机插件隔离存储（secrets.json，Windows DPAPI 按当前用户加密）；完整 Key 不会回传到界面。");

  const keyRow = row(dom, key, testBtn, saveBtn);
  const actionRow = row(dom, masked, clearBtn, demoBtn);
  box.append(keyRow, actionRow, note);

  let lastView = {};

  const keyValue = () => {
    const value = String(key.value ?? "").trim();
    if (!value) state.status.set("请先填写 API Key", "error");
    return value;
  };

  testBtn.on("click", () => {
    const value = keyValue();
    if (value) ctx.bus.publish(TOPIC_CMD, { action: "testKey", key: value });
  });
  saveBtn.on("click", () => {
    const value = keyValue();
    if (!value) return;
    editing = false;
    ctx.bus.publish(TOPIC_CMD, { action: "saveKey", key: value });
    key.value = "";
  });
  clearBtn.on("click", () => {
    editing = false;
    key.value = "";
    ctx.bus.publish(TOPIC_CMD, { action: "clearKey" });
  });
  demoBtn.on("click", () => {
    editing = false;
    const demo = lastView?.config?.demo !== true;
    ctx.bus.publish(TOPIC_CMD, { action: "saveConfig", config: { demo } });
  });

  function render(view) {
    lastView = view ?? {};
    const account = lastView.account;
    masked.textContent = account
      ? `当前：${account.maskedKey}`
      : lastView.config?.demo
        ? "当前：演示模式"
        : "未配置 Key";
    demoBtn.textContent = lastView.config?.demo ? "退出演示" : "演示数据";
    clearBtn.disabled = !account && lastView.config?.demo !== true;
    if (!editing) key.value = "";
    if (lastView.state === "auth_error") {
      note.className = "g-error";
      note.textContent = "API Key 无效或已过期，请重新填写。";
    } else if (lastView.config?.demo) {
      note.className = "g-note";
      note.textContent = "演示模式不出网，数据是固定种子。";
    } else {
      note.className = "g-muted";
      note.textContent = "凭据保存在本机插件隔离存储（secrets.json，Windows DPAPI 按当前用户加密）；完整 Key 不会回传到界面。";
    }
  }

  return { box, render };
}
