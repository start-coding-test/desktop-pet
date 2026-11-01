// 插件目录变动 → 「本窗要不要整页换一茬文档」的唯一判定点（只在 dev 构建生效）。
//
// 为什么必须重载：ESM 的模块映射表按 URL 记忆，入口 URL 上的 `?v=` 只能让入口重跑
// （见 plugin-url.ts），而插件内部手写的相对 import（子模块）URL 恒定 —— 覆盖子模块后
// 同一个 realm 永远拿回旧实例，这与 HTTP 缓存无关。只有文档重载才会丢掉整张映射表。
// 为什么不做真隔离级别的方案：进程内插件的承载窗口本来就是文档级作用域，重载即最小闭环；
// 等 Web Worker 宿主落地后再重新评估（见 AGENTS.md 的安全边界共识）。
//
// 判定与被判定分开：`decideHotReload` 是纯函数（dev 由调用方传入，离线单测覆盖两条分支），
// `applyHotReload` 是三个接入点用的装配层 —— 只在这里真的碰 `location`。

export interface HotReloadDecision {
  /** 变更列表里、本窗确实承载着的插件 id（按首次出现去重） */
  carried: string[];
  /** 该不该真的重载本窗文档 */
  shouldReload: boolean;
}

/** 从 `host:plugins-changed` 载荷里取出「这一轮被动过的插件 id」；取不到（旧宿主/坏载荷）按空数组处理 */
export function changedIdsFrom(payload: unknown): string[] {
  return idListFrom(payload, "ids");
}

/**
 * 取出「模块文件被覆盖」的那部分 id —— 重载只认它。
 * 为什么收窄：`ids` 里会有只动了 `manifest.json` 的插件，那种改动 reconcile 重读就够，
 * 为它整页换茬会抹掉窗口里的运行状态（宿主的回归脚本正是靠反复重写 manifest 要能力，
 * 一旦算进重载集合，套件会在中途丢掉自己注入的全局）。
 */
export function reloadIdsFrom(payload: unknown): string[] {
  return idListFrom(payload, "reloadIds");
}

/**
 * 取 id 列表：只认**非空**字符串，按首次出现去重（附录2 N6）。
 *
 * 同一个 id 在载荷里出现两次是常态（一次覆盖可能被 watcher 的两条路径各报一遍）：
 * 不去重会让上层把同一个插件重启两遍，第二遍往往撞在刚拆了一半的会话上；
 * 空串/空白 id 直接丢掉 —— 它在会话表里会注册出一个键为空的条目，既查不到也删不掉。
 */
function idListFrom(payload: unknown, key: "ids" | "reloadIds"): string[] {
  const list = (payload as Record<string, unknown> | null | undefined)?.[key];
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/**
 * 纯判定：输入「变更的插件 id 列表 + 本窗是否承载某插件」，输出可观测的判定结果。
 * dev 是参数而不是从模块环境读的 —— 这条逻辑离线可测，副作用留给装配层。
 */
export function decideHotReload(
  changedIds: readonly string[],
  carries: (pluginId: string) => boolean,
  dev: boolean,
): HotReloadDecision {
  const carried: string[] = [];
  for (const id of changedIds) {
    if (!carried.includes(id) && carries(id)) carried.push(id);
  }
  return { carried, shouldReload: dev && carried.length > 0 };
}

/**
 * dev 构建判定：只认 Vite 的 `import.meta.env.DEV`（打包版会被静态替换为 false），
 * 不是任何能被环境变量或调试入口随手打开的开关。
 * 先落回局部变量再读是可测性考虑：node 离线单测没有 Vite 注入，`import.meta.env`
 * 不存在（undefined），`?.` 让离线判定安全落到 false（顺带证明离线环境不碰 location）。
 */
function devBuild(): boolean {
  const env: { readonly DEV?: boolean } | undefined = import.meta.env;
  return env?.DEV === true;
}

/**
 * 装配层：dev 下变更命中了本窗承载的插件就整页重载（非 dev、无交集一律不动）。
 * 返回判定结果，三个接入点与测试都读它；`location.reload()` 自带防抖由宿主 watcher 的
 * 600ms 去抖兜住 —— 一次覆盖只会换来一轮广播，不会自激。
 */
export function applyHotReload(
  changedIds: readonly string[],
  carries: (pluginId: string) => boolean,
): HotReloadDecision {
  const decision = decideHotReload(changedIds, carries, devBuild());
  if (decision.shouldReload) location.reload();
  return decision;
}
