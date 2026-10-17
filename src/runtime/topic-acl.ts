// topic 命名空间归属：`${pluginId}:xxx` 归该插件所有，其余（ble:heart-rate、host:* 等）归宿主。
// 插件只能在自己命名空间内发布；跨命名空间订阅必须是**公开 topic**（见 PUBLIC_TOPICS），
// 且仍要 manifest 显式声明 bus:subscribe。这里只是防串门的策略层，授权与否仍由 Rust 判定。
import { PUBLIC_TOPICS } from "../../packages/sdk/topics.js";
import { BUS_PUBLISH, BUS_SUBSCRIBE } from "./plugin-capabilities";

function isOwn(pluginId: string, topic: string): boolean {
  return topic.startsWith(`${pluginId}:`);
}

export function assertPublishable(pluginId: string, topic: string): void {
  if (!topic.endsWith("*") && isOwn(pluginId, topic)) return;
  throw new Error(
    `[${pluginId}] 无权发布 topic "${topic}"：只能发布 "${pluginId}:" 前缀（宿主 topic 由宿主注入）`,
  );
}

export function assertSubscribable(pluginId: string, topic: string, permissions: string[]): void {
  if (isOwn(pluginId, topic)) return;
  if (topic.endsWith("*")) {
    throw new Error(`[${pluginId}] 通配订阅 "${topic}" 越过了自己的命名空间`);
  }
  // ADR-0011：跨命名空间只有「公开 topic」这一条路。以前声明了 bus:subscribe 就能订
  // 任意他插件的 topic（含别人的 `:widget` 展示数据）—— 那是把「订阅权限」当成了
  // 「读任意命名空间的权限」。现在只放行宿主登记为公开的那批名字。
  if (!(PUBLIC_TOPICS as readonly string[]).includes(topic)) {
    throw new Error(
      `[${pluginId}] 订阅 "${topic}" 被拒：只能订自己的前缀，或公开 topic（${PUBLIC_TOPICS.join("、")}）`,
    );
  }
  if (!permissions.includes(BUS_SUBSCRIBE)) {
    throw new Error(`[${pluginId}] 订阅 "${topic}" 需要在 manifest 声明 bus:subscribe`);
  }
}

/** 交给插件/widget 的总线视图：只有 publish/subscribe，拿不到 handlers 与 inject */
type BusLike = {
  publish(topic: string, payload: unknown, pluginId?: string): void;
  subscribe(topic: string, handler: (payload: unknown) => void, pluginId?: string): () => void;
};

export type ScopedBus = {
  publish(topic: string, payload: unknown): void;
  subscribe(topic: string, handler: (payload: unknown) => void): () => void;
};

export function createScopedBus(
  pluginId: string,
  permissions: string[],
  bus: BusLike,
): ScopedBus {
  return Object.freeze({
    publish: (topic: string, payload: unknown): void => {
      assertPublishable(pluginId, topic);
      if (!permissions.includes(BUS_PUBLISH)) {
        throw new Error(`[${pluginId}] 发布需要在 manifest 声明 bus:publish`);
      }
      // 带上 pluginId：中继那侧按它校验前缀与 bus:publish 授权（见 commands/bus.rs）
      bus.publish(topic, payload, pluginId);
    },
    subscribe: (topic: string, handler: (payload: unknown) => void): (() => void) => {
      assertSubscribable(pluginId, topic, permissions);
      // 带上 pluginId：`*:widget` 的回灌要按它校验 topic 归属（S4，见 commands/bus.rs::bus_peek）
      return bus.subscribe(topic, handler, pluginId);
    },
  });
}
