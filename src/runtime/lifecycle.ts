// 生命周期隔离（附录2 N5）：插件的 activate / deactivate 是第三方代码，任何一步抛错
// 都只能影响它自己。三条硬要求，全部落在这里：
//
//   1) 宿主自己的收尾步骤（订阅回收、widget 卸载、共享资源释放）不能因为前一步抛错被跳过 ——
//      否则一个坏插件会把 ble 持有者、Shadow DOM 插槽一起漏在内存里；
//   2) 事件回调（`listen(...)` 的 handler）是 fire-and-forget，抛出去只会变成
//      一条 unhandledrejection，被 boot-error 当成整窗「致命错误」红条盖住（G4-11）；
//   3) 失败必须留痕（回调里报给调用方），但**不改变**其余步骤的执行顺序。
//
// 纯逻辑、不碰 DOM：离线单测直接驱动（tests/unit/unit-runtime-acceptance.mjs）。

/** 一步收尾动作：名字进错误报告，run 抛错不影响后面的步骤 */
export interface IsolatedStep {
  name: string;
  run: () => unknown;
}

/** 失败回调：拿到步骤名与原始错误（宿主通常把两者拼成一条 host:plugin-error） */
export type StepErrorHandler = (step: string, error: unknown) => void;

/**
 * 顺序执行 steps，逐条兜住异常：永不 throw，返回失败步骤名。
 *
 * 顺序保持不变是刻意的 —— 停用必须是「先让插件自己收尾，再收宿主的订阅/资源」，
 * 乱序会让插件在已回收的通道上再发一次请求。
 */
export async function runIsolated(
  steps: readonly IsolatedStep[],
  onError: StepErrorHandler,
): Promise<string[]> {
  const failed: string[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (err) {
      failed.push(step.name);
      // 上报本身也不许把循环带停：宿主的上报路径（emit / console）也可能是坏的
      try {
        onError(step.name, err);
      } catch (reportError) {
        console.error(`[lifecycle] 上报步骤 ${step.name} 的失败时又抛了`, reportError);
      }
    }
  }
  return failed;
}

/** 把「可能同步抛、可能 reject」的回调包成「一定不抛」的回调（事件监听用） */
export function safeCallback<T>(
  label: string,
  handler: (value: T) => unknown,
  onError: (label: string, error: unknown) => void,
): (value: T) => void {
  const report = (error: unknown): void => {
    try {
      onError(label, error);
    } catch (reportError) {
      console.error(`[lifecycle] 上报 ${label} 的失败时又抛了`, reportError);
    }
  };
  return (value: T) => {
    try {
      const out = handler(value);
      // 只认 thenable：handler 多半是 async 函数，它的 reject 不能被静默丢掉
      if (out !== null && typeof out === "object" && "then" in out) {
        void Promise.resolve(out).catch(report);
      }
    } catch (err) {
      report(err);
    }
  };
}
