// 权限同意框：展示插件身份与申请的能力，用户决定后回传宿主。
// 宿主可能在窗口开着时追加能力，所以这里用 consent_details 有界轮询同一 req_id，
// 不新增事件或命令（ADR-0013 §3.4）。
import { getCurrentWindow } from "@tauri-apps/api/window";
import { asHostError, hostCall, NOT_FOUND } from "../runtime/host-error";
import "./style.css";

interface ConsentDetails {
  req_id: string;
  plugin_id: string;
  plugin_name: string;
  caps: string[];
}

const POLL_MS = 400;
// 宿主侧组级超时是 60s；前端多留 5s 余量后停止轮询，让宿主自己的收口负责关窗。
const POLL_MAX_MS = 65_000;

function showStatus(text: string): void {
  const box = document.getElementById("plugin-name");
  if (box) box.textContent = text;
}

function renderCaps(caps: string[]): void {
  const list = document.getElementById("cap-list");
  if (!list) return;
  list.replaceChildren();
  // 宿主返回的是并集，这里仍去重一次：轮询/追加交错时不让同一能力重复出现在界面上。
  for (const cap of [...new Set(caps)]) {
    const li = document.createElement("li");
    li.textContent = cap;
    list.append(li);
  }
}

function closeExpired(message: string): void {
  showStatus(message);
  const list = document.getElementById("cap-list");
  list?.replaceChildren();
  window.close();
}

async function main(): Promise<void> {
  const reqId = getCurrentWindow().label.replace(/^consent-/, "");
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const startedAt = Date.now();

  const stopPolling = (): void => {
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const refresh = async (): Promise<void> => {
    if (stopped || inFlight) return;
    if (Date.now() - startedAt > POLL_MAX_MS) {
      // 宿主会在 60s 组级超时里关窗；这里只停表，不替宿主写拒绝锁。
      stopPolling();
      return;
    }
    inFlight = true;
    try {
      const details = await hostCall<ConsentDetails>("consent_details", { reqId });
      if (stopped) return;
      document.getElementById("plugin-name")!.textContent =
        `${details.plugin_name}（${details.plugin_id}）`;
      renderCaps(details.caps);
    } catch (err) {
      if (stopped) return;
      const e = asHostError(err);
      if (e.code === NOT_FOUND) {
        // 请求已被答复/取消：按 ADR-0013，不再调用 consent_answer，直接关窗。
        stopPolling();
        closeExpired("本次授权请求已经失效");
        return;
      }
      // 偶发读写/传输错误不关窗、不替用户作答，继续下一轮轮询。
      showStatus("读取授权详情失败，正在重试…");
    } finally {
      inFlight = false;
    }
  };

  await refresh();
  if (stopped) return;
  timer = setInterval(() => void refresh(), POLL_MS);

  const answer = (granted: boolean): void => {
    if (stopped) return;
    stopPolling();
    void hostCall("consent_answer", { reqId, granted }).finally(() => window.close());
  };
  document.getElementById("btn-allow")!.addEventListener("click", () => answer(true));
  document.getElementById("btn-deny")!.addEventListener("click", () => answer(false));
  // 用户直接关窗/宿主卸载页面时停表；不在卸载期额外发 consent_answer。
  window.addEventListener("pagehide", stopPolling);
  window.addEventListener("beforeunload", stopPolling);
}

void main();
