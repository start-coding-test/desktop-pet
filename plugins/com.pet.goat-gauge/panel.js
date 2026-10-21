// C07：:panel 只读投影的纯函数。键集固定；Cookie/Key 的值永远不进 panel。
export const COOKIE_STATES = ["none", "ready", "expired", "unavailable", "error"];

export function buildPanelPayload({
  history = [],
  fetchedAt = 0,
  daily = [],
  records = [],
  charts = {},
  cookieState = "none",
} = {}) {
  return {
    history: history.map((row) => [...row]),
    fetchedAt: Number(fetchedAt) || 0,
    daily: daily.map((day) => ({ ...day, by_model: { ...day.by_model } })),
    records: records.map((record) => ({ ...record })),
    charts: Object.fromEntries(
      Object.entries(charts).map(([day, buckets]) => [day, buckets.map((bucket) => ({ ...bucket }))]),
    ),
    cookieState: COOKIE_STATES.includes(cookieState) ? cookieState : "none",
  };
}
