/**
 * 设备名的展示/存储口径（G5-12）。
 *
 * 扫描列表里把 RSSI 拼在选项文本后面（「Polar H10（-60 dBm）」）是为了让人挑得中，
 * 但信号强度不是设备身份的一部分：原实现点「连接」时直接现取 `option.textContent`，
 * 于是「Polar H10（-60 dBm）」被当成设备名存进了配置、也进了状态文案与回显。
 * 这里统一把尾部的「（-60 dBm）」/「(-60 dBm)」剥掉，只留真名；
 * 名字为空（全是空白）就当没有名字，由调用方回落到「未命名设备」/设备 id。
 *
 * @param {unknown} name 广播/存储里来的名字
 * @returns {string|null} 剥掉信号后缀的干净名字；不是非空字符串时返回 null
 */
export function stripSignalSuffix(name) {
  if (typeof name !== "string") return null;
  const cleaned = name
    .replace(/\s*[（(]\s*[-+]?\d+(?:\.\d+)?\s*dBm\s*[)）]\s*$/i, "")
    .trim();
  return cleaned === "" ? null : cleaned;
}
