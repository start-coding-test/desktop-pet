// 设置页回显的「编辑锁」（G5-04 / N5 / G9-09）。
//
// 问题：分组开关、指数下拉、K线周期下拉以前每帧无条件写回宿主推来的配置值。
// 用户刚点过的控件，在下一次推送（配置还没追上这次点击）到来时被冲回旧值 ——
// 视觉上是「点了没用」，甚至会把用户的选择写回默认。
//
// 口径与 goat-gauge 的 prefs.js 一致（两个插件不能互相 import，各自留一份同式实现）：
//   - 控件被用户碰过 → 记进 locks，回显先绕开它；
//   - 推送里的值追上用户所选 → 复位放行（这时写回的就是用户自己选的那项，冲不掉东西）；
//   - 不在锁上 → 只写变化的值，别每帧重发同一个 op。
//
// 三个 helper 都返回「这一帧有没有真的写下去」，方便单测与以后排查。

/**
 * select：锁上且还没追上 → 不动；追上 → 放行。
 * @param {any} node 虚拟节点（有 value 属性）
 * @param {string} want 推送里的目标值
 * @param {Set<any>} locks 正在锁定的节点集合
 * @returns {boolean} 是否写了 value
 */
export function syncSelect(node, want, locks) {
  const value = String(node.value ?? "");
  if (locks.has(node)) {
    if (value === want) locks.delete(node);
    else return false;
  }
  if (value === want) return false;
  node.value = want;
  return true;
}

/**
 * checkbox：同上，按 checked 判。
 * @param {any} node
 * @param {boolean} want
 * @param {Set<any>} locks
 * @returns {boolean}
 */
export function syncCheck(node, want, locks) {
  if (locks.has(node)) {
    if (node.checked === want) locks.delete(node);
    else return false;
  }
  if (node.checked === want) return false;
  node.checked = want;
  return true;
}

/**
 * radio 组：checked 是整组语义（勾一个就自动取消别人），组里只要有一个在锁上
 * 就整组别碰 —— 否则写别人的 checked 等于把用户刚选的那项取消掉。
 * @param {Array<[string, any]>} entries [值, 节点] 列表
 * @param {string} want 目标值
 * @param {Set<any>} locks
 * @returns {boolean} 是否写过 checked
 */
export function syncRadioGroup(entries, want, locks) {
  for (const [value, box] of entries) {
    if (!locks.has(box)) continue;
    if (box.checked && value === want) locks.delete(box);
    return false;
  }
  let wrote = false;
  for (const [value, box] of entries) {
    const next = value === want;
    if (box.checked !== next) {
      box.checked = next;
      wrote = true;
    }
  }
  return wrote;
}
