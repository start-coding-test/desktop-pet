// 设置窗与 agent:hooks 受控能力（原 2445-3066）
// 由 tests/e2e/verify-isolation.mjs 拆出（R3 / G9-08）；只做搬运与 state 化改写，断言语义未变。

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { env } from "node:process";
import { readEnabledIds, reloadAndWait, waitUntil } from "../harness/cdp.mjs";
import { PRESEED_HOOK_ID, PRESEED_HOOK_UNDECLARED_ID, PROBE_ID, unisolatedAgentAdapters } from "../harness/fixtures.mjs";
import { waitWidgetRealm } from "../harness/widget-realm.mjs";
import { CONSENT_NOT_SETTLED, consentVerdict, driveConsent, noConsentThroughout, settledWithin } from "./consent.mjs";
import { E2E_DIR, E2E_SETTINGS, PLUGINS_DIR, REAL_SETTINGS, fileSha256OrNull, readE2eHotkey, sleep } from "./env.mjs";

/** 顺序调用的一段：整段原文搬来，跨段的值走 state（赋值时机不变）。 */
export async function phaseSettingsHooks(state) {
  const r = state.r;
  const call = state.call;
  const sCall = state.sCall;
  const sc = state.sc;
  const { enableForConsent, grantProbeCap, logConsoleLedger } = state;
  if (sc) {
    await new Promise((res) => setTimeout(res, 3000));
    const installed = (await sCall("plugins_list")).v ?? [];
    // 清单在宿主那边，从设置窗读同一个源即可（别再读 localStorage 那个旧键）
    const enabledIds = await readEnabledIds(sCall);
    const navViews = () =>
      sc.ev(`[...document.querySelectorAll('#nav-list .nav-item')].map(b => b.dataset.view).join(',')`);

    r.group("侧栏结构：宠物设置 + 插件列表");
    r.check(
      "第一项是宠物设置，其余每个已装插件一项",
      "pet," + installed.map((m) => m.id).sort().join(","),
      await navViews(),
    );
    r.check(
      "宠物设置这一页含形象/快捷键/自启/游戏模式四张卡片（Agent 卡片已移交插件页）",
      '["桌宠形象","唤出本页的全局快捷键","开机自动运行","游戏模式"]',
      JSON.stringify(await sc.ev(`[...document.querySelectorAll('[data-panel=pet] .card h2')].map(h => h.textContent)`)),
    );
    r.check(
      "宠物设置里含形象/快捷键/自启/游戏模式的控件",
      '[true,true,true,true,true,true]',
      JSON.stringify(await sc.ev(
        `['skin-list','hotkey-input','autostart-switch','game-mode-switch','skin-name','hotkey-test']` +
          `.map(id => !!document.getElementById(id))`,
      )),
    );
    r.check(
      "Agent 卡片的 DOM 与控件已删干净（不留死代码）",
      '[false,false,false,false,false]',
      JSON.stringify(await sc.ev(
        `['agent-status','agent-detail','agent-install','agent-uninstall','agent-refresh'].map(id => !!document.getElementById(id))`,
      )),
    );
    r.check("初始只有 pet 面板可见", "pet", await sc.ev(`[...document.querySelectorAll('[data-panel]')].filter(p => !p.hidden).map(p => p.dataset.panel).join(',')`));

    r.group("点插件 → 插件页（内容交给插件的 widget）");
    // 用零权限探针：开它的开关不会在宠物窗那边弹同意框，断言不会被授权对话框卡住
    r.check("探针此刻是停用态（下面要验开关流程）", false, enabledIds.includes(PROBE_ID));
    await sc.ev(`document.querySelector('.nav-item[data-view=${JSON.stringify(PROBE_ID)}]').click(); true`);
    await new Promise((res) => setTimeout(res, 500));
    r.check("切过去只留插件面板", "plugin", await sc.ev(`[...document.querySelectorAll('[data-panel]')].filter(p => !p.hidden).map(p => p.dataset.panel).join(',')`));
    r.check("标题换成插件名", "隔离探针", await sc.ev(`document.getElementById('view-title').textContent`));
    // 这一组原先硬编码「权限条数 = 0」，那是**读到过期 manifest** 的假象：上面为了走同意框
    // 已经往探针的 manifest 里逐项写过 permissions，设置窗重新取列表后条数就不再是 0。
    // 改成跟磁盘现场逐字对账 —— 既更严（名字与顺序都要一致），也不会再随写文件的顺序随机红。
    const permsOnDisk = (JSON.parse(readFileSync(join(PLUGINS_DIR, PROBE_ID, "manifest.json"), "utf8")).permissions ?? []).join(",");
    r.check("壳上给了插件 id", PROBE_ID, await sc.ev(`document.getElementById('plugin-id')?.textContent ?? '(没有该元素)'`));
    r.check(
      "权限条与磁盘上的 manifest.permissions 逐字一致（含顺序）",
      permsOnDisk,
      await sc.ev(`[...document.querySelectorAll('#plugin-perms .perm-chip')].map((n) => n.textContent).join(',')`),
    );
    r.check(
      "停用状态下不挂插件页面，并说明原因",
      true,
      await sc.ev(
        `!document.querySelector('#plugin-settings div[data-plugin-id=${JSON.stringify(PROBE_ID)}]')` +
          ` && !document.getElementById('plugin-note').hidden && /启用后/.test(document.getElementById('plugin-note').textContent)`,
      ),
    );
    // 在插件页里开开关：widget 应挂进 #plugin-settings，内容是插件自己的
    await sc.ev(`(() => { const t = document.getElementById('plugin-toggle'); t.checked = true; t.dispatchEvent(new Event('change')); })()`);
    const mountedInPage = await waitUntil(
      sc,
      `!!document.querySelector('#plugin-settings div[data-plugin-id=${JSON.stringify(PROBE_ID)}][data-region="settings"]')`,
      12_000,
    );
    r.check("启用后插件自己的设置页挂进来了", true, mountedInPage);
    r.check("侧栏那个点跟着变亮", true, await sc.ev(`!!document.querySelector('.nav-item[data-view=${JSON.stringify(PROBE_ID)}] .nav-dot.on')`));
    await sc.ev(`(() => { const t = document.getElementById('plugin-toggle'); t.checked = false; t.dispatchEvent(new Event('change')); })()`);
    await sleep(1200);
    r.check(
      "停用后 widget 摘干净（不留孤儿节点）",
      0,
      await sc.ev(`document.querySelectorAll('#plugin-settings div[data-plugin-id=${JSON.stringify(PROBE_ID)}]').length`),
    );

    r.group("搜索过滤的是插件列表");
    await sc.ev(`(() => { const i = document.getElementById('search'); i.value = 'ble:scan'; i.dispatchEvent(new Event('input')); })()`);
    r.check(
      "按权限搜索只剩声明它的插件",
      1,
      await sc.ev(`[...document.querySelectorAll('#nav-plugins .nav-item')].filter(b => b.style.display !== 'none').length`),
    );
    await sc.ev(`(() => { const i = document.getElementById('search'); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
    r.check("清空搜索后侧栏恢复完整", installed.length, await sc.ev(`[...document.querySelectorAll('#nav-plugins .nav-item')].filter(b => b.style.display !== 'none').length`));

    // 上面只是把探针开了又关，清单该回到起点
    const afterToggle = await readEnabledIds(sCall);
    r.check("插件启停回到起点", JSON.stringify([...enabledIds].sort()), JSON.stringify([...afterToggle].sort()));
    await sc.ev(`document.querySelector('.nav-item[data-view=pet]').click(); true`);
    await new Promise((res) => setTimeout(res, 400));
    r.check("回到宠物设置", "pet", await sc.ev(`[...document.querySelectorAll('[data-panel]')].filter(p => !p.hidden).map(p => p.dataset.panel).join(',')`));
    r.check("离开插件页后插件页被卸载", 0, await sc.ev(`document.querySelectorAll('#plugin-settings div[data-plugin-id]').length`));

    // ---------- B2：agent:hooks 受控能力（settings 区专属，ADR-0001） ----------
    // 探针复用 zz.probe 目录（.gitignore 已忽略、收尾统一删除）。把它的 widget 换成
    // 「钩子能力探针」：mount 本身不发起任何调用，只把 ctx 形状与手动调用函数挂到 window，
    // 免得早先的挂载/开关用例被同意框打断。
    logConsoleLedger("before agent hooks");
    r.group("agent:hooks 受控能力（settings 区专属）");
    const TEMP_ROOT = resolve(E2E_DIR, "../../temp");
    const hookId = PRESEED_HOOK_ID;
    // S3 之后 settings 区一律进 Worker：探针必须按 Worker 契约写 —— 没有 window / document，
    // 建节点只能用 ctx.dom，事实只能经 ctx.bus 回传。两条 bus 能力按 manifest 声明，
    // 并在本组开头真拿到授权（见下 grantProbeCap），否则 publish / subscribe 会被能力门禁拦下。
    const hookManifest = (permits) =>
      JSON.stringify({
        id: hookId,
        name: "钩子能力探针",
        version: "0.0.0",
        entry: "index.js",
        widget: "widget.js",
        apiVersion: 2,
        permissions: ["bus:publish", "bus:subscribe", ...permits],
        description: "验证 agent:hooks 的受控注入面与同意流程。",
      });
    /** 收事实：探针在 Worker 里写不了 window，事实只能由本窗口的总线订阅者接住 */
    const WATCH_HOOK_FACTS = `(async () => {
      const { bus } = await import('/src/runtime/event-bus.ts');
      window.__hookFacts = [];
      window.__hookRes = [];
      bus.subscribe('${hookId}:fact', (p) => window.__hookFacts.push(p));
      bus.subscribe('${hookId}:res', (p) => window.__hookRes.push(p));
      return true;
    })()`;
    /** 把探针挂进某个区：容器共用同一个临时槽，槽缺就先建 */
    const mountHookRegion = (region) => `(async () => {
      const { widgetHost } = await import('/src/runtime/widget-host.ts');
      window.__hookHost = widgetHost;
      let slot = document.getElementById('hook-probe-slot');
      if (!slot) { slot = document.createElement('div'); slot.id = 'hook-probe-slot'; document.body.append(slot); }
      await widgetHost.mount(${hookManifest([])}, ${JSON.stringify(region)}, slot);
      return true;
    })()`;
    /** 例外名单是跨窗口共享的一份 localStorage：装/拆都要显式做，别让别的组跟着漂 */
    const hookPin = (on) =>
      sc.ev(
        on
          ? `localStorage.setItem('host:widget-realm-plugin-host', ${JSON.stringify(hookId)}); true`
          : `localStorage.removeItem('host:widget-realm-plugin-host'); true`,
      );
    let hookCallSeq = 0;
    /** 指令经总线投给探针，结果同样经总线回来；回传不了就返回可读失败而不是 TypeError */
    const hookCall = async (name) => {
      const id = ++hookCallSeq;
      await sc.ev(`(async () => {
        const { bus } = await import('/src/runtime/event-bus.ts');
        bus.inject('${hookId}:cmd', { id: ${id}, name: ${JSON.stringify(name)} });
        return true;
      })()`);
      const hit = `((window.__hookRes || []).find((r) => r.id === ${id} && r.region === "settings")) ?? null`;
      const got = await waitUntil(sc, `!!(${hit})`, 15_000).catch(() => false);
      if (!got) return { ok: false, e: `探针没回传 ${name} 的结果（15s）` };
      return sc.ev(hit);
    };


    // 起点确定：清掉上一次（可能崩溃留下）的旧授权，否则 permission_check 会短路掉声明校验。
    // 必须排在下面拿 bus 授权之前：permission_revoke 是 revoke_all，会把 bus 能力一并清掉。
    await sCall("permission_revoke", { pluginId: hookId });

    // 探针的事实只能经总线回传，所以两条 bus 能力要真授权（各自一个真实同意框）
    r.check("探针经同意框拿到 bus:publish（Worker 里回传事实的前提）", true, await grantProbeCap("bus:publish", hookId));
    r.check("探针经同意框拿到 bus:subscribe（Worker 里收指令的前提）", true, await grantProbeCap("bus:subscribe", hookId));
    await sc.ev(WATCH_HOOK_FACTS);

    // S3 的正身：例外名单里点着 zz.probe，settings 区照样进 Worker
    await hookPin(true);
    // 已定口径：旧接口 widget（没写 apiVersion）在 settings 区被拦下并给可读原因，不是留在宿主 realm 跑。
    // 点名也救不了它 —— 所以这条在名单开着的时候测。原因文案的可读性由 unit 那条钉住（closed shadow 读不到 body）
    const legacyRealm = await sc.ev(`(async () => {
      const { widgetHost } = await import('/src/runtime/widget-host.ts');
      let slot = document.getElementById('hook-probe-slot-2');
      if (!slot) { slot = document.createElement('div'); slot.id = 'hook-probe-slot-2'; document.body.append(slot); }
      await widgetHost.mount({ id: 'zz.legacyprobe', widget: 'widget.js', permissions: [] }, 'settings', slot);
      const n = document.querySelector('#hook-probe-slot-2 div[data-plugin-id="zz.legacyprobe"]');
      const realm = n ? n.dataset.widgetRealm : null;
      await widgetHost.unmount('zz.legacyprobe');
      document.getElementById('hook-probe-slot-2')?.remove();
      return realm;
    })()`);
    r.check("旧接口 widget 在 settings 区被拦下（blocked，点名也不放行）", "blocked", legacyRealm);
    await sc.ev(mountHookRegion("settings"));
    r.check(
      "例外名单点着这个插件，settings 区仍进 Worker（S3）",
      "worker",
      (await waitWidgetRealm(sc, hookId, "settings", "worker", 20_000)).actual,
    );
    // 另两区照旧认例外名单：把名单摘掉它们才进 Worker —— 顺带钉住「名单只管 badge / overlay」
    await hookPin(false);
    await sc.ev(mountHookRegion("badge"));
    await sc.ev(mountHookRegion("overlay"));
    r.check("badge 区进 Worker", "worker", (await waitWidgetRealm(sc, hookId, "badge", "worker", 20_000)).actual);
    r.check("overlay 区进 Worker", "worker", (await waitWidgetRealm(sc, hookId, "overlay", "worker", 20_000)).actual);
    await hookPin(true); // 后面几组仍按老前提（例外名单开着）跑

    const factsOk = await waitUntil(sc, `(window.__hookFacts || []).length >= 3`, 20_000).catch(() => false);
    const facts = factsOk ? await sc.ev(`window.__hookFacts`) : [];
    const shapeOf = (region) => facts.find((f) => f.region === region) ?? {};
    r.check(
      "探针在 settings/badge/overlay 三区都把事实经总线传了回来",
      "badge,overlay,settings",
      [...new Set(facts.map((f) => f.region))].sort().join(","),
    );
    r.check(
      "settings 区注入 ctx.host.agentHooks（且只有这一个键）",
      true,
      shapeOf("settings").hasAgentHooks === true && (shapeOf("settings").keys ?? []).join(",") === "agentHooks",
    );
    r.check(
      "badge 区取到的 ctx.host 是 undefined（断言 undefined，不是调用报错）",
      true,
      shapeOf("badge").hostIsUndefined === true && shapeOf("badge").hasAgentHooks === false,
    );
    r.check(
      "overlay 区取到的 ctx.host 是 undefined",
      true,
      shapeOf("overlay").hostIsUndefined === true && shapeOf("overlay").hasAgentHooks === false,
    );

    // 此刻探针确定没有 agent:hooks，且下面这次调用不会弹同意框（窗口门禁过了走的是能力校验）
    const hookSnapBefore = JSON.stringify((await sCall("agent_hooks_status")).v);
    const unauthUninstall = await sCall("agent_hooks_uninstall", { pluginId: hookId });
    const hookSnapAfter = JSON.stringify((await sCall("agent_hooks_status")).v);
    r.check(
      "设置窗带 pluginId 但未授权 agent:hooks：能力门禁拒且配置快照未动",
      "denied|true",
      `${unauthUninstall.code}|${hookSnapBefore === hookSnapAfter}`,
    );
    const undeclared = await sc.ev(`(async () => {
      const { createAgentHooksApi } = await import('/src/runtime/bridge.ts');
      const api = createAgentHooksApi({ id: ${JSON.stringify(PROBE_ID)}, name: '未声明钩子探针', permissions: ['agent:hooks'] });
      try { await api.status(); return { ok: true }; }
      catch (e) { return { ok: false, e: String(e?.message ?? e) } }
    })()`);
    r.check(
      "未声明 agent:hooks：settings 区调用被拒（未声明的能力不弹框，直接拒）",
      true,
      undeclared.ok === false && /未在 manifest 声明/.test(undeclared.e),
    );

    // 声明后：首次调用应弹同意框。先拒绝一次，再同意。
    const restoreHookProbe = await enableForConsent(hookId);
    const pendingDeny = hookCall("status");
    const consentDeny = await driveConsent("deny", hookId);
    r.check("同意框列出了 agent:hooks", true, consentDeny.caps.some((x) => x.includes("agent:hooks")));
    // 同意框标题是既有文案 `${plugin_name}（${plugin_id}）`（consent/main.ts:34），断言整串
    r.check("同意框显示的是探针插件名（既有文案含 id）", `钩子能力探针（${hookId}）`, consentDeny.name);
    const denied = await pendingDeny;
    r.check("拒绝后调用被拒（默认拒绝语义）", true, denied.ok === false && /权限被拒绝/.test(denied.e));

    // ADR-0013 I4：同轮第二次申请命中拒绝锁，不再弹窗；停用/启用清锁后才允许恢复。
    // D09 W-1：先让第二次调用带 5s 超时落地 —— 挂到超时就是拒绝锁没生效，当场具名红；
    // 之前是「扫一次没窗就算过」，而开窗是异步几百毫秒后的事，那条判据抓不到任何变异。
    const pendingAllow = hookCall("status");
    const racedAllow = await settledWithin(pendingAllow);
    if (racedAllow === CONSENT_NOT_SETTLED) {
      // 锁失效会留下一扇没人答的窗；收掉它，别让后面的用例连坐丢掉尾部汇总
      await driveConsent("deny", hookId).catch(() => null);
    }
    const deniedAgain = await pendingAllow;
    r.check(
      "拒绝锁下第二次调用 5s 内直接落地（不是挂到超时）",
      "false",
      racedAllow === CONSENT_NOT_SETTLED ? "TIMEOUT" : String(racedAllow?.ok),
    );
    r.check("拒绝后同轮不再弹（第二次无新窗）", true, consentVerdict(await noConsentThroughout(hookId)));
    r.check("拒绝后第二次调用仍被拒", true, deniedAgain.ok === false && /权限被拒绝/.test(deniedAgain.e));

    const restoreAllow = await enableForConsent(hookId);
    let allowed;
    try {
      const pendingRetry = hookCall("status");
      const consentAllow = await driveConsent("allow", hookId);
      r.check("停用再启用后拒绝锁已清（可再次弹窗）", true, consentAllow.caps.some((x) => x.includes("agent:hooks")));
      allowed = await pendingRetry;
    } finally {
      await restoreAllow();
    }
    r.check("同意后 settings 区调用放行", true, allowed.ok === true);
    const hostStatus = await sCall("agent_hooks_status");
    r.check("status 回显与宿主路径一致", JSON.stringify(allowed.v), JSON.stringify(hostStatus.v));

    // 宠物窗主 realm：绕过 JS 桥直接 invoke 必须被窗口门禁拒（label=pet）
    const petStatus = await call("agent_hooks_status");
    r.check("宠物窗直接 invoke status 被拒（label=pet）", true, petStatus.ok === false && /设置窗/.test(String(petStatus.e)));
    const petInstall = await call("agent_hooks_install", { pluginId: hookId });
    r.check("宠物窗带 pluginId 的 install 同样被窗口门禁拒", true, petInstall.ok === false && /设置窗/.test(String(petInstall.e)));
    const petUninstall = await call("agent_hooks_uninstall", { pluginId: hookId });
    r.check("宠物窗直接 invoke agent_hooks_uninstall（带 pluginId）被窗口门禁拒", "denied", petUninstall.code);

    // 写盘类断言只在宿主被指到 temp/ 时跑（PET_AGENT_CONFIG_FILES 启动方式）；
    // 否则一律不改写真实用户配置，只做只读断言。
    const statusFiles = Array.isArray(allowed.v?.files) ? allowed.v.files : [];
    const underTemp = statusFiles.length > 0 && statusFiles.every((f) => resolve(String(f.path)).startsWith(TEMP_ROOT + sep));
    r.info("hook 配置落点", statusFiles.map((f) => f.path).join(" ； ") || "(空)");
    // 上面那道门只锁得住 Qoder：statusFiles 是宿主按当前 agent 回显的候选文件，
    // 而不带 pluginId 的卸载走 uninstall_everywhere —— 扫 adapters::wired() 四家。
    // 没有 PET_AGENT_HOME 换根时，ZCode/Codex/WorkBuddy 的候选文件顺着真实 home 解析，
    // 写盘断言就会改写用户自己的配置（Bug1）。凡碰这条 sweep 的组，额外过这道隔离门。
    const isolationGap = unisolatedAgentAdapters(env, homedir());
    r.check("直调卸载前四家都已被隔离变量指到 temp", [], isolationGap);
    const sweepSafe = underTemp && isolationGap.length === 0;

    let sampleForeign = "";
    // 「他人条目未变」的比较口径：宿主用 serde_json 整文件重写（BTreeMap 按键排序），
    // 键序会被归一 —— 两侧都按键排序后比较（与 Rust 单测同口径），键序差异不算改动。
    const canon = (value) => {
      if (Array.isArray(value)) return value.map(canon);
      if (value && typeof value === "object") {
        const out = {};
        for (const k of Object.keys(value).sort()) out[k] = canon(value[k]);
        return out;
      }
      return value;
    };
    const foreignOf = (text) => {
      const v = JSON.parse(text);
      return JSON.stringify([canon(v.hooks.PreToolUse[0].hooks[0]), canon(v.hooks.Stop[0].hooks[0])]);
    };
    if (underTemp) {
      const sample = JSON.stringify(
        {
          theme: "dark",
          hooks: {
            PreToolUse: [{ hooks: [
              { type: "command", command: "other-tool --notify", timeout: 5 },
              { type: "command", command: `"D:\\old\\desktop-pet.exe" --pet-hook pre`, timeout: 2 },
            ] }],
            Stop: [{ hooks: [{ type: "command", command: "keep.sh", timeout: 3 }] }],
          },
        },
        null,
        2,
      );
      for (const f of statusFiles) writeFileSync(f.path, sample);
      sampleForeign = foreignOf(sample);

      const installRes = await hookCall("install");
      r.check(
        "声明并同意后 install 成功（每个文件回显条数）",
        true,
        installRes.ok === true && Array.isArray(installRes.v?.files) && installRes.v.files.every((f) => f.managed > 0 && !f.error),
      );
      const afterInstall = (await sCall("agent_hooks_status")).v;
      r.check("install 后 status 回显条数与文件数一致", afterInstall.managed, statusFiles.length * afterInstall.expectedPerFile);
      for (const f of statusFiles) {
        const text = readFileSync(f.path, "utf8");
        r.check("install 后样例只有自家条目在增", afterInstall.expectedPerFile, text.split("--pet-hook").length - 1);
        r.check("install 后他人 hook 条目逐字段未变（键序由宿主归一）", sampleForeign, foreignOf(text));
      }
    } else {
      r.skip(
        "写盘断言（install 与连带卸载）",
        "hook 配置未指向 temp/：断言不做（会改写真实用户配置）；" +
          '用 PET_AGENT_CONFIG_FILES="<temp>\\a.json;<temp>\\b.json" npm run dev:debug 启动可跑全量',
      );
    }

    // 设置窗直调卸载（不带 pluginId，宿主路径）：翻候选文件摘自家条目，他人条目必须原样；
    // 铁律是随后经探针装回 —— 不装回会把后面「连带卸载」两条分支的起点掏空成假绿
    if (sweepSafe) {
      const foreignBeforeDirect = statusFiles.map((f) => foreignOf(readFileSync(f.path, "utf8")));
      const directUninstall = await sCall("agent_hooks_uninstall");
      const afterDirect = (await sCall("agent_hooks_status")).v;
      const marksAfterDirect = statusFiles.map((f) => readFileSync(f.path, "utf8").split("--pet-hook").length - 1);
      const foreignAfterDirect = statusFiles.map((f) => foreignOf(readFileSync(f.path, "utf8")));
      const reinstall = await hookCall("install");
      const afterReinstall = reinstall.ok === true ? (await sCall("agent_hooks_status")).v : { managed: -1 };
      const foreignAfterReinstall = statusFiles.map((f) => foreignOf(readFileSync(f.path, "utf8")));
      r.check(
        "宿主路径直调卸载（设置窗、不带 pluginId）：managed 归零、他人条目未变，随后经探针装回",
        `true|0|${statusFiles.map(() => 0).join(",")}|true|${statusFiles.length * afterDirect.expectedPerFile}`,
        [
          directUninstall.ok === true,
          afterDirect.managed,
          marksAfterDirect.join(","),
          JSON.stringify(foreignBeforeDirect) === JSON.stringify(foreignAfterDirect) &&
            JSON.stringify(foreignAfterReinstall) === JSON.stringify(foreignBeforeDirect),
          reinstall.ok === true && afterReinstall.managed,
        ].join("|"),
      );
    } else {
      r.skip(
        "直调卸载再装回断言",
        underTemp
          ? `不带 pluginId 的卸载会扫四家，而这几种 agent 仍指向真实 home：${isolationGap.join(", ")}（缺 PET_AGENT_HOME 换根）`
          : "hook 配置未指向 temp/：直调卸载会改写真实用户配置，与本组 install 断言同一开关（PET_AGENT_CONFIG_FILES）",
      );
    }

    // ---------- 撤销授权两条分支（CONTEXT.md 生命周期） ----------
    // 先重载设置窗：manifest 改写后要拿到刷新过的权限列表（nav 的 data-search 带权限名）。
    await reloadAndWait(sc);
    r.check(
      "设置页在 manifest 改写后刷新出 agent:hooks 权限",
      true,
      await waitUntil(sc, `document.querySelector('.nav-item[data-view=${JSON.stringify(hookId)}]')?.dataset.search?.includes('agent:hooks') === true`, 10_000),
    );
    // 重载把 window 上的订阅与桥缓存都清了：重挂 settings 区那一个（例外名单开着，它照样进 Worker）、
    // 重订事实通道，再走一次 status 把缓存填上
    await hookPin(true);
    await sc.ev(WATCH_HOOK_FACTS);
    await sc.ev(mountHookRegion("settings"));
    await waitWidgetRealm(sc, hookId, "settings", "worker", 20_000);
    const regrant = await hookCall("status");
    r.check("重载后凭已授权记录直接放行（不再弹框）", true, regrant.ok === true);

    // 所有点击都先等元素出现、缺了产出可读 FAIL —— 固定 sleep 赌渲染会在缺元素时抛
    // TypeError 把整个套件打断（上一轮就是这么丢掉尾部汇总的）。
    // 注意：撤销按钮是 **class** `btn-revoke`（settings/main.ts:158 用 el() 的第三参赋 className），
    // 不是 id —— 上一轮用 getElementById 查它永远为 null，是脚本选择器写错，不是产品缺口。
    const clickReady = async (selector) => {
      const ready = await waitUntil(sc, `!!document.querySelector(${JSON.stringify(selector)})`, 8_000).catch(() => false);
      if (ready) await sc.ev(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
      return ready;
    };

    const navOpened = await clickReady(`.nav-item[data-view=${JSON.stringify(hookId)}]`);
    const hasRevokeBtn = navOpened && (await waitUntil(sc, `!!document.querySelector('.btn-revoke')`, 8_000).catch(() => false));
    r.check("插件壳上出现「撤销授权」（class=btn-revoke，声明列表已刷新）", true, hasRevokeBtn);

    // 分支一「只撤能力」：不写 hook 配置文件，任何模式都可跑
    const beforeSnap = JSON.stringify((await sCall("agent_hooks_status")).v);
    const beforeBytes = underTemp ? statusFiles.map((f) => readFileSync(f.path, "utf8")) : [];
    r.check(
      "撤销前桥缓存里有 agent:hooks（下面「失效」才是真的变化）",
      true,
      (await sc.ev(`(async () => (await import('/src/runtime/bridge.ts')).grantedCapabilities(${JSON.stringify(hookId)}).includes('agent:hooks'))()`)) === true,
    );
    if (hasRevokeBtn) await clickReady(".btn-revoke");
    // Bug3 之后这一行只对声明 agent:hooks 的插件出现，而且默认不勾。
    // 判据拆成两半：「勾选框不存在」与「存在但没勾」是两种不同的红，别混成一条。
    const hasUninstallBox =
      hasRevokeBtn === true && (await waitUntil(sc, `!!document.getElementById('revoke-uninstall')`, 5_000).catch(() => false));
    r.check("声明 agent:hooks 的插件：确认条里有「同时卸载 hook」勾选框", true, hasUninstallBox);
    const stripUp =
      hasUninstallBox === true &&
      (await waitUntil(sc, `document.getElementById('revoke-uninstall')?.checked === false`, 3_000).catch(() => false));
    r.check("该勾选框默认不勾（Bug3：撤销授权不等于卸载 hook）", true, stripUp);
    if (stripUp) {
      await clickReady("#revoke-go");
    }
    r.check(
      "「只撤能力」的回显",
      true,
      stripUp && (await waitUntil(sc, `document.querySelector('.btn-revoke')?.textContent.includes("仅能力") === true`, 8_000).catch(() => false)),
    );
    r.check(
      "确认条执行后收起",
      0,
      stripUp ? await sc.ev(`document.querySelectorAll('#revoke-confirm').length`) : "撤销流程未执行（前一步失败）",
    );
    r.check("「只撤能力」不动 hook 配置（宿主回显不变）", beforeSnap, JSON.stringify((await sCall("agent_hooks_status")).v));
    if (underTemp) {
      r.check("「只撤能力」后样例文件字节不变", true, statusFiles.every((f, i) => readFileSync(f.path, "utf8") === beforeBytes[i]));
    }
    // 撤销后缓存失效是异步广播（host:permission-revoked）：轮询断言，别一次性查询竞态
    r.check(
      "「只撤能力」后桥的能力缓存失效",
      true,
      await waitUntil(sc, `(async () => !(await import('/src/runtime/bridge.ts')).grantedCapabilities(${JSON.stringify(hookId)}).includes('agent:hooks'))()`, 5_000),
    );

    // Bug3 的反面对照：zz.hookundeclared 声明了 storage（所以有「撤销授权」入口），
    // 但没声明 agent:hooks —— 它的确认条里不该出现「同时卸载 Agent hook」这一行。
    // 这条判据钉的是「误伤不再可能」：astock/todo/hr-ble 走的正是同一条渲染分支。
    const undeclaredOpened = await clickReady(`.nav-item[data-view=${JSON.stringify(PRESEED_HOOK_UNDECLARED_ID)}]`);
    const undeclaredBtn =
      undeclaredOpened && (await waitUntil(sc, `!!document.querySelector('.btn-revoke')`, 8_000).catch(() => false));
    r.check("未声明 agent:hooks 的插件也有「撤销授权」入口", true, undeclaredBtn);
    if (undeclaredBtn) await clickReady(".btn-revoke");
    const undeclaredStripUp =
      undeclaredBtn === true &&
      (await waitUntil(sc, `!!document.getElementById('revoke-confirm') && !document.getElementById('revoke-uninstall')`, 5_000).catch(() => false));
    r.check("它的确认条里没有「同时卸载 hook」勾选框（Bug3）", true, undeclaredStripUp);
    // 只取消，不真的撤这个对照插件的授权 —— 撤了会改变后面组的起点
    await clickReady("#revoke-cancel");
    r.check("取消后确认条收起", 0, await sc.ev(`document.querySelectorAll('#revoke-confirm').length`));

    // 分支二「连带卸载」：写盘，且宿主侧不带 pluginId 的那条路会扫四家 —— 要过 sweepSafe
    if (sweepSafe) {
      await clickReady(`.nav-item[data-view=pet]`);
      await clickReady(`.nav-item[data-view=${JSON.stringify(hookId)}]`);
      const hasBtn2 = await waitUntil(sc, `!!document.querySelector('.btn-revoke')`, 8_000).catch(() => false);
      r.check("重新进入插件页后撤销按钮再次可用", true, hasBtn2);
      if (hasBtn2) await clickReady(".btn-revoke");
      // Bug3 之后默认不勾，连带卸载这一步要自己勾上 —— 顺手把「勾上确实换了行为」
      // 也跑到了：不勾（分支一）不动配置文件，勾上（这里）才摘条目。
      const boxUp2 =
        hasBtn2 === true && (await waitUntil(sc, `!!document.getElementById('revoke-uninstall')`, 5_000).catch(() => false));
      const ticked =
        boxUp2 === true &&
        (await sc.ev(
          `(() => { const b = document.getElementById('revoke-uninstall'); b.checked = true; return b.checked === true; })()`,
        )) === true;
      r.check("第二次确认条默认不勾、勾上才走连带卸载（Bug3 反转原「默认勾选」判据）", true, hasBtn2 === true && boxUp2 && ticked);
      const stripUp2 = boxUp2 && ticked;
      if (stripUp2) await clickReady("#revoke-go");
      r.check(
        "「连带卸载」的回显",
        true,
        stripUp2 && (await waitUntil(sc, `document.querySelector('.btn-revoke')?.textContent.includes("含卸载 hook") === true`, 8_000).catch(() => false)),
      );
      const clean = (await sCall("agent_hooks_status")).v;
      r.check("「连带卸载」后配置文件干净", 0, clean.managed ?? -1);
      for (const f of statusFiles) {
        const text = readFileSync(f.path, "utf8");
        r.check("卸载后 --pet-hook 条目归零", 0, text.split("--pet-hook").length - 1);
        r.check("卸载后他人 hook 条目逐字段未变（键序由宿主归一）", sampleForeign, foreignOf(text));
      }
    } else {
      r.skip(
        "连带卸载分支",
        underTemp
          ? `这条路径点确认后同样调 agent_hooks_uninstall 扫四家，未隔离：${isolationGap.join(", ")}`
          : "hook 配置未指向 temp/",
      );
    }

    await sc.ev(`(async () => { await window.__hookHost.unmount(${JSON.stringify(hookId)}); document.getElementById('hook-probe-slot')?.remove(); return true; })()`);
    await clickReady(`.nav-item[data-view=pet]`);
    await restoreHookProbe();

    // A31：热键组前后只比真实 settings 的 sha256/存在性；内容只看 PET_SETTINGS_DIR 下的副本。
    const realSettingsBefore = fileSha256OrNull(REAL_SETTINGS);
    // E02：debug 构建可用 PET_HOTKEY_DEFAULT 覆盖默认键（机器B 的 Ctrl+Alt+P 被占）。
    // 判据跟着宿主返回的 default 走，不再把某一台机器的占键状态写死；产品默认仍由 Rust 单测钉住。
    const hotkeyInfo = (await sCall("hotkey_status")).v ?? {};
    const defaultAccel =
      typeof hotkeyInfo.default === "string" && hotkeyInfo.default
        ? hotkeyInfo.default
        : "CommandOrControl+Alt+P";
    r.check("hotkey_status 返回可用的默认加速键", true, typeof hotkeyInfo.default === "string" && !!hotkeyInfo.default);
    r.check(
      "默认加速键保留 Tauri 跨平台 token",
      true,
      defaultAccel.split("+").includes("CommandOrControl"),
    );
    const envDefault = process.env.PET_HOTKEY_DEFAULT;
    if (envDefault) {
      r.check("PET_HOTKEY_DEFAULT 生效：status.default 与 env 逐字一致", envDefault, defaultAccel);
    } else {
      r.info("未设 PET_HOTKEY_DEFAULT：默认键按产品常量判定", "");
    }
    const noMod = await sCall("hotkey_set", { accelerator: "P" });
    r.check("不带修饰键的组合被拒", true, !noMod.ok && /修饰键/.test(String(noMod.e)));
    const twoKeys = await sCall("hotkey_set", { accelerator: "Ctrl+A+B" });
    r.check("两个主键的组合被拒", true, !twoKeys.ok && /主键/.test(String(twoKeys.e)));
    const asDefault = await sCall("hotkey_set", { accelerator: defaultAccel });
    r.check("Tauri 跨平台 token 被接受（默认值本身必须能设）", true, asDefault.ok);
    const moved = await sCall("hotkey_set", { accelerator: "ctrl+alt+f9" });
    r.check("改键成功并归一化", "Ctrl+Alt+F9", moved.v);
    r.check("状态读回的是改后的键", "Ctrl+Alt+F9", (await sCall("hotkey_status")).v?.accelerator);
    if (E2E_SETTINGS) {
      r.check("改键写进 PET_SETTINGS_DIR 的 settings.json", "Ctrl+Alt+F9", readE2eHotkey());
    } else {
      r.skip("隔离文件回读", "未设 PET_SETTINGS_DIR（本地裸跑）");
    }
    // 这条判据原来只印 `.v`：hostInvoke 的 reject 分支形状是 `{ok:false,e,code}`、根本没有 `v`，
    // 于是 run#153 只剩一句「实得 undefined」，宿主真正的拒绝文案被丢掉（L09）。
    // 读回本身也可能超时，所以它的异常只折进诊断行，绝不要把下面的 r.check 一起带走。
    const backToDefault = await sCall("hotkey_set", { accelerator: defaultAccel });
    if (!backToDefault.ok) {
      let liveNow = null;
      try {
        liveNow = (await sCall("hotkey_status")).v ?? null;
      } catch (err) {
        liveNow = { readbackFailed: String(err?.message ?? err).slice(0, 120) };
      }
      r.info("「改回默认值」拒绝现场", JSON.stringify({ e: backToDefault.e ?? null, code: backToDefault.code ?? null, status: liveNow }));
    }
    r.check("改回默认值", defaultAccel, backToDefault.v);
    if (E2E_SETTINGS) {
      r.check("改回默认值也写进隔离文件", defaultAccel, readE2eHotkey());
    }
    const realSettingsAfter = fileSha256OrNull(REAL_SETTINGS);
    r.check(
      "真实 %APPDATA% settings.json 运行前后一致（只比 sha256/存在性）",
      true,
      realSettingsAfter === realSettingsBefore,
    );

    logConsoleLedger("after agent hooks");
    r.group("hotkey_test：试注册命令的门禁、语法码与不改现状");
    const petHotkeyTest = await call("hotkey_test", { accelerator: "Ctrl+Alt+F8" });
    r.check("宠物窗直接 invoke hotkey_test 被窗口门禁拒", "denied", petHotkeyTest.code);
    const badSyntaxTest = await sCall("hotkey_test", { accelerator: "P" });
    r.check("语法错的组合拒绝时带 code=invalid-arg", "invalid-arg", badSyntaxTest.code);
    // 试的就是「当前生效」的那个键：注册必然报已占用，那不是冲突 —— 命令必须识别并直接放行
    const liveAccel = (await sCall("hotkey_status")).v?.accelerator;
    const liveTest = await sCall("hotkey_test", { accelerator: liveAccel });
    r.check("当前生效的键试注册必得 true（不把已占用误报成冲突）", true, liveTest.v);
    // 试注册不得有副作用：命令只做瞬时的注册/注销。当前生效键恰好就是它时对「当前键」直接放行 true，
    // 两次仍走 true 分支，所以不需要为这种情形另设前置分支
    const hkBefore = JSON.stringify((await sCall("hotkey_status")).v);
    const t1 = await sCall("hotkey_test", { accelerator: "Ctrl+Alt+F9" });
    const t2 = await sCall("hotkey_test", { accelerator: "Ctrl+Alt+F9" });
    const hkAfter = JSON.stringify((await sCall("hotkey_status")).v);
    r.check(
      "试注册不改变现状：同一空闲键连试两次都 true、hotkey_status 前后不变",
      "true|true|true",
      [t1.v, t2.v, hkBefore === hkAfter].join("|"),
    );

    const auto = await sCall("autostart_status");
    r.check("自启状态带真实路径与 dev 标记", true, typeof auto.v?.devBuild === "boolean" && /\.exe$/.test(auto.v?.exe ?? ""));
    const gated = await call("autostart_set", { enabled: true });
    r.check("自启只能由设置窗改", true, !gated.ok && /设置窗/.test(String(gated.e)));
    const gatedKey = await call("hotkey_set", { accelerator: "Ctrl+Alt+F8" });
    r.check("快捷键只能由设置窗改", true, !gatedKey.ok && /设置窗/.test(String(gatedKey.e)));
    r.check("设置窗自身无报错", [], sc.noise);
    await sCall("plugin:window|close").catch(() => undefined);
    sc.close();
  }

  // ---------- B3：气泡常驻状态行（宿主侧） ----------
  // 两个 fixture（id 不同）验「每个插件各占一条 + 回落」；同一份入口脚本靠 ctx.pluginId 区分 topic。
  logConsoleLedger("before B3");
  const b3WindowStart = (state.c.noise ?? []).length;
  state.b3WindowStart = b3WindowStart;
}
