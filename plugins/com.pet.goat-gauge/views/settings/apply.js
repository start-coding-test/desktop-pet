// 币种/汇率「应用」的纯决策（G5-02）。拆出来只为可离线单测：DOM 在 Worker 里拿不到，
// 但「先校验还是先放锁」这件事必须被钉住。
//
// 原实现先 editing.delete(rateInput) 再校验：汇率非法被拒时锁已经放掉，
// 下一次推送把输入框冲回旧值，用户连改错的机会都没有。
// 币种是 select 且「选了立即生效」——它的锁等推送里的值追上用户所选时由 syncSelect 放行，
// 这里不能提前删，否则外部改的币种就再也进不来。
export const RATE_MIN = 1;
export const RATE_MAX = 20;

/** 汇率的入库值：合法返回两位小数的数，非法返回 null（由调用方报错） */
export function ratePatch(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < RATE_MIN || rate > RATE_MAX) return null;
  return Math.round(rate * 100) / 100;
}

/**
 * 「应用」的完整决策：校验不过 → patch=null（补丁不发、汇率锁也不放）；
 * 通过 → { patch: {currency, usdToCny}, releaseRate: true }。
 * @param {{rate?: unknown, currency?: unknown}} input
 * @returns {{patch: {currency: string, usdToCny: number} | null, releaseRate: boolean}}
 */
export function currencyPatch(input = {}) {
  const usdToCny = ratePatch(input.rate);
  if (usdToCny === null) return { patch: null, releaseRate: false };
  const currency = input.currency === "CNY" ? "CNY" : "USD";
  return { patch: { currency, usdToCny }, releaseRate: true };
}
