// `:widget` 的载荷瘦身（G5-06）。
//
// 明细（records，最多 300 条）原来随每轮 `:widget` 一起广播，但它只被插件页的「明细」页签用，
// 那边走 `:panel` 就够；而 `:widget` 每 60 秒（演示模式更快）刷一次，宠物窗里每个订阅者
// 都要反序列化这 300 条。这里按「谁看什么」切开：`:widget` 去掉 records，其余字段原样保留
// （概览/趋势页还要 daily 与 charts）。纯函数、返回新对象，离线单测钉住。
const WIDGET_OMIT = ["records"];

/**
 * @param {Record<string, unknown>} view publishView 组装的完整视图
 * @returns {Record<string, unknown>} 去掉明细后的 :widget 载荷
 */
export function splitView(view) {
  const out = { ...view };
  for (const key of WIDGET_OMIT) delete out[key];
  return out;
}
