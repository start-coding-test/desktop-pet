// 渲染写入去重：Worker 路线下每个 op 都是一条跨 realm 消息，
// 倒计时每秒重算时只有真正变化的文字/类名/属性才下发。
// 纯函数，不碰 ctx/DOM；cache 由每个挂载实例自己持有。

export function setTextIfChanged(node, value, cache, key = "text") {
  const next = String(value ?? "");
  if (cache[key] === next) return false;
  cache[key] = next;
  node.textContent = next;
  return true;
}

export function setClassIfChanged(node, value, cache, key = "class") {
  const next = String(value ?? "");
  if (cache[key] === next) return false;
  cache[key] = next;
  node.className = next;
  return true;
}

export function setAttrIfChanged(node, name, value, cache) {
  const next = value === null ? null : String(value);
  const key = `attr:${name}`;
  if (cache[key] === next) return false;
  cache[key] = next;
  node.setAttribute(name, next);
  return true;
}

export function setDatasetIfChanged(node, key, value, cache) {
  const next = String(value ?? "");
  const cacheKey = `data:${key}`;
  if (cache[cacheKey] === next) return false;
  cache[cacheKey] = next;
  node.dataset[key] = next;
  return true;
}
