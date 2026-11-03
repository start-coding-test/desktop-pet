// 设置页回显的「编辑锁」：契约见 docs/plugin-dev/PLUGIN_SDK.md 的「6.1 设置页回显与防冲写」。
//
// 为什么每个插件各留一份：插件文件只由 `petplugin://<自己的 id>/…` 提供，
// 协议层 `is_safe_rel` 拒绝 `..` 段，插件之间无法 import 彼此的模块（见 PLUGIN_SDK 6.1）。
// 因此共享发生在源码级：本文件是 com.pet.astock/views/settings/lock.js 的同式实现，
// 改契约时两处一起改；复制到新插件必须保留这段来源说明。
//
// 口径（G5-04 / N5 / G9-09）：
//   - 控件被用户碰过 → 记进 locks，回显先绕开它；
//   - 推送里的值追上用户所选 → 复位放行（这时写回的就是用户自己选的那项，冲不掉东西）；
//   - 不在锁上 → 只写变化的值，别每帧重发同一个 op。
// 三个 helper 都返回「这一帧有没有真的写下去」，方便单测与排查。

/**
 * select / input：锁上且还没追上 → 不动；追上 → 放行。
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
