import { hostCall, hostErrorMessage } from "../runtime/host-error";
import { AGENT_HOOKS, RISK_FLAGS } from "../runtime/plugin-capabilities";
import { validateManifest } from "../runtime/plugin-runtime";
import { widgetHost } from "../runtime/widget-host";
import { $, el } from "./dom";
import { enabledSet } from "./nav";
import { showNotice } from "./notice";
import { manifests, mountedFor, selected, setMountedFor } from "./state";

/* ---------- 插件页：壳由宿主给，中间那块由插件自己渲染 ---------- */

export async function detachWidget(): Promise<void> {
  if (!mountedFor) return;
  const id = mountedFor;
  setMountedFor(null);
  // widget 卸载失败不该把「切页」这一步带崩（不然换插件时整窗停在旧页）
  await widgetHost.unmount(id).catch((error) => {
    console.error(`[settings] 卸载 ${id} 的插件页失败`, error);
  });
  const box = $<HTMLDivElement>("plugin-settings");
  box?.replaceChildren();
}

/**
 * chips 是 manifest **声明**的能力，不是授权记录（N8：不能假装有授权）。
 * 授权表的事实来源在宿主：逐项问 `permission_check`，把「已授权几项」写在 chips 下面；
 * 问不到就明说「未知」，不拿声明冒充记录。
 */
async function fillGrantHint(
  pluginId: string,
  declared: readonly string[],
  hint: HTMLElement
): Promise<void> {
  if (declared.length === 0) {
    hint.textContent = "该插件没有声明需要授权的能力";
    return;
  }
  let granted: boolean[] | null = null;
  try {
    granted = await Promise.all(
      declared.map((capability) => hostCall<boolean>("permission_check", { pluginId, capability }))
    );
  } catch (error) {
    console.error(`[settings] 查询 ${pluginId} 的授权状态失败`, error);
    granted = null;
  }
  if (!hint.isConnected) return; // 页面已经切走，别把结果写到新页面上
  if (!granted) {
    hint.textContent = `授权状态未知（宿主未应答）：${declared.length} 项声明能力会在首次调用时弹确认框`;
    return;
  }
  const yes = granted.filter(Boolean).length;
  hint.textContent =
    yes > 0
      ? `已授权 ${yes}/${declared.length} 项；其余能力首次调用时弹确认框`
      : "当前没有已授权能力；首次调用时宿主会弹确认框";
}

export async function renderPluginPage(): Promise<void> {
  const manifest = manifests.find((m) => m.id === selected);
  const icon = $<HTMLDivElement>("plugin-icon");
  const name = $<HTMLSpanElement>("plugin-name");
  const version = $<HTMLSpanElement>("plugin-version");
  const idLine = $<HTMLDivElement>("plugin-id");
  const desc = $<HTMLDivElement>("plugin-desc");
  const perms = $<HTMLDivElement>("plugin-perms");
  const toggle = $<HTMLInputElement>("plugin-toggle");
  const toggleLabel = $<HTMLSpanElement>("plugin-toggle-label");
  const note = $<HTMLParagraphElement>("plugin-note");
  const box = $<HTMLDivElement>("plugin-settings");
  if (!manifest || !icon || !name || !version || !idLine || !desc || !perms || !toggle || !box) return;

  const invalid = validateManifest(manifest);
  icon.textContent = (manifest.name || manifest.id).trim().slice(0, 1).toUpperCase();
  name.textContent = invalid ? manifest.id : manifest.name;
  version.textContent = invalid ? "" : `v${manifest.version}`;
  idLine.textContent = manifest.id;
  desc.textContent = invalid ? "" : (manifest.description ?? "");

  perms.replaceChildren();
  if (invalid) {
    perms.append(el("span", `manifest 无效：${invalid}`, "perm-chip warn"));
  } else {
    for (const p of manifest.permissions ?? []) {
      // 风险面口径来自共享名单（RISK_FLAGS：可出网/可落盘/可改用户外部配置），
      // 不再在调用点硬编码名字 —— 名单里加一条同样有副作用的能力就自动被标险
      perms.append(el("span", p, "perm-chip" + (RISK_FLAGS.includes(p) ? " warn" : "")));
    }
    // 声明 ≠ 已授权：单独一行说清授权表的实况（N8）
    const hint = el("span", "授权状态查询中…", "perm-hint");
    perms.append(hint);
    void fillGrantHint(
      manifest.id,
      manifest.permissions ?? [],
      hint
    );
    if ((manifest.permissions ?? []).length > 0) {
      const revoke = el("button", "撤销授权", "btn-revoke");
      revoke.type = "button";
      revoke.addEventListener("click", () => {
        // 撤销前的宿主确认条（CONTEXT.md「生命周期」）：默认只撤能力。
        // 「同时卸载 Agent hook」这一行**只对声明了 agent:hooks 的插件出现**：勾选走的是
        // 宿主侧 agent_hooks_uninstall（不带 pluginId → 扫 adapters::wired() 四家），
        // 与 astock / todo / hr-ble 这些没声明该能力的插件毫无关系，默认连带卸载就是误伤（Bug3）。
        // 卸载复用宿主路径而不带 pluginId：撤销入口在宿主壳里，不能指望插件还活着来收自己的 hook。
        const canUninstallHooks = (manifest.permissions ?? []).includes(AGENT_HOOKS);
        const strip = el("div", undefined, "revoke-confirm");
        strip.id = "revoke-confirm";
        let alsoUninstall: HTMLInputElement | null = null;
        if (canUninstallHooks) {
          const line = el("label", undefined, "row-line");
          alsoUninstall = document.createElement("input");
          alsoUninstall.type = "checkbox";
          alsoUninstall.id = "revoke-uninstall";
          // 默认不勾：撤能力与卸 hook 是两件事，要连带得由用户明确勾上
          alsoUninstall.checked = false;
          line.append(alsoUninstall, document.createTextNode("同时卸载 Agent hook"));
          strip.append(line);
        }
        const go = el("button", "确认撤销");
        go.type = "button";
        go.id = "revoke-go";
        const cancel = el("button", "取消");
        cancel.type = "button";
        cancel.id = "revoke-cancel";
        cancel.addEventListener("click", () => strip.remove());
        go.addEventListener("click", async () => {
          go.disabled = true;
          if (alsoUninstall?.checked) {
            try {
              await hostCall("agent_hooks_uninstall");
            } catch (err) {
              // 卸载失败不拦住撤权：能力先收回，失败原因留给宿主日志
              console.error("[settings] 撤销时卸载 hook 失败", err);
            }
          }
          try {
            await hostCall("permission_revoke", { pluginId: manifest.id });
            revoke.textContent = alsoUninstall?.checked ? "已撤销（含卸载 hook）" : "已撤销（仅能力）";
            revoke.disabled = true;
            // 撤销是宿主端的真动作：撤销后重新问一次授权表，别让「声明列表」继续冒充记录
            void fillGrantHint(manifest.id, manifest.permissions ?? [], hint);
            showNotice(
              alsoUninstall?.checked
                ? `已撤销「${manifest.name || manifest.id}」的全部能力，并卸载了 Agent hook`
                : `已撤销「${manifest.name || manifest.id}」的全部能力；它下次调用会重新弹确认框`,
              "info"
            );
          } catch (err) {
            // 撤销现在是宿主端会失败的命令（门禁、非法 id），不能装成成功
            revoke.textContent = `撤销失败：${hostErrorMessage(err)}`;
            go.disabled = false;
            showNotice(`撤销「${manifest.name || manifest.id}」的授权失败：${hostErrorMessage(err)}`);
          }
          strip.remove();
        });
        strip.append(go, cancel);
        revoke.after(strip);
      });
      perms.append(revoke);
    }
  }

  const on = enabledSet().has(manifest.id);
  toggle.checked = on;
  toggle.disabled = !!invalid;
  if (toggleLabel) toggleLabel.textContent = on ? "已启用" : "已停用";

  if (note) note.hidden = true;
  if (invalid) {
    await detachWidget();
    if (note) {
      note.textContent = "这个插件的 manifest 有问题，未加载。修好后放回插件目录即可。";
      note.hidden = false;
    }
    return;
  }

  // 内容由插件提供：它自己的 widget.js 挂在 settings 区的独立 Shadow DOM 里
  if (!on) {
    await detachWidget();
    if (note) {
      note.textContent = "启用后这里才显示插件自己的页面。";
      note.hidden = false;
    }
    return;
  }
  if (!manifest.widget) {
    await detachWidget();
    if (note) {
      note.textContent = "这个插件没有提供设置页面。";
      note.hidden = false;
    }
    return;
  }
  if (mountedFor !== manifest.id) {
    await detachWidget();
    setMountedFor(manifest.id);
    try {
      await widgetHost.mount(manifest, "settings", box);
    } catch (e) {
      setMountedFor(null);
      console.error(`[settings] mount widget: ${manifest.id}`, e);
      if (note) {
        note.textContent = `插件页面加载失败：${String(e instanceof Error ? e.message : e)}`;
        note.hidden = false;
      }
      return;
    }
  }
}
