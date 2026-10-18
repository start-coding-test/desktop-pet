// 宠物本体暴露给插件运行时的受控注册点。
// 插件经 ctx.pet.* 影响本体（插播状态、弹气泡），拿不到 canvas 与宿主 DOM。
import { PET_STATES } from "./petdex-states";
import type { ActionName } from "./sprites";

export type { ActionName };

/** 插件可用的状态名 = petdex 九状态，一个不多一个不少 */
export const PET_ACTIONS: ActionName[] = PET_STATES.map((s) => s.id);

export function isPetAction(value: unknown): value is ActionName {
  return typeof value === "string" && (PET_ACTIONS as string[]).includes(value);
}

export interface PetController {
  react(action: ActionName): void;
  say(text: string): void;
  /**
   * 常驻状态行（B3）：**每个插件各占一条**（按 pluginId 存一个有序表），界面显示**最近设置**的那一条。
   * `null` 删掉这个插件自己那条：删完回落到剩下最近的一条，都没了就收起气泡。
   *
   * 返回值只关于**调用方这一条**：设置时是生效后的文本（已清洗、已截断），清除时是 null。
   * 界面上那一刻显示的是不是它，由回落规则决定 —— 别拿返回值当「气泡现在长什么样」。
   *
   * `pluginId` 由桥那一层填（插件面的 `ctx.pet.setStatus` 不暴露它）。
   */
  setStatus(pluginId: string, text: string | null): string | null;
}

let controller: PetController | null = null;

export function registerPetController(next: PetController | null): void {
  controller = next;
}

export function petController(): PetController | null {
  return controller;
}
