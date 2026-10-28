// 「完成 / 取消完成」的落盘顺序（G5-09）。
// 原实现先 await ctx.pet.react / ctx.pet.say 再落盘：宠物调用一 reject
// （权限被拒、宿主忙、停用中），异常冒到 handleCmd 外，落盘那行直接跳过 ——
// 界面上的勾选变了、存储里却没变，下次激活又回到未完成。
// 这里把顺序钉死：先落盘（失败就把内存改回去并抛出），宠物调用只是事后效果，
// 它失败只记日志，不许再影响状态。

export const DONE_EMOJI = "🎉";

/**
 * @param {any} task 待办项（就地改写 done/completed）
 * @param {boolean} done 目标是完成还是重新打开
 * @param {object} [deps]
 * @param {string|null} [deps.completed] 完成日期（done 时用 today()）
 * @param {() => Promise<void>} [deps.save] 落盘；抛错才会回滚
 * @param {(err: Error) => void} [deps.rollback] 回滚时的记录钩子
 * @param {(level: string) => Promise<void>} [deps.react] 宠物反应
 * @param {(text: string) => Promise<void>} [deps.say] 宠物台词
 * @param {(err: Error) => void} [deps.note] 宠物调用失败时的记录钩子
 */
export async function commitDone(task, done, deps = {}) {
  const { completed = null, save, rollback, react, say, note } = deps;
  if (!task || typeof save !== "function") return;
  const before = { done: task.done, completed: task.completed };
  task.done = done === true;
  task.completed = task.done ? completed : null;
  try {
    await save();
  } catch (err) {
    task.done = before.done;
    task.completed = before.completed;
    rollback?.(err);
    throw err;
  }
  if (!task.done) return;
  try {
    // 落盘之后才碰宠物：这两步 reject 只影响表情与台词，不该把已存下的状态带回去
    await react?.("jumping");
    await say?.(`「${task.text}」搞定！${DONE_EMOJI}`);
  } catch (err) {
    note?.(err);
  }
}
