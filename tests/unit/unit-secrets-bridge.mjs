// B09 / F6：JS 桥侧的 secrets 门禁。只证「宿主答拒绝 ⇒ 三方法 reject 且无 secrets_* IPC」，
// 不证「manifest 未声明 storage」—— 那一关在 Rust 侧 ensure_declared。
import { test } from "node:test";
import assert from "node:assert/strict";

import { calls, resetStub, setReply } from "./tauri-stub.mjs";

const { buildContext, invalidatePermissions } = await import("../../src/runtime/bridge.ts");

const secretCalls = () => calls.filter((c) => String(c.cmd).startsWith("secrets_"));

test("宿主拒绝时 ctx.secrets 三方法均被拒，且一条 secrets_* IPC 都不发", async () => {
  resetStub();
  setReply("permission_check", false);
  setReply("permission_request", false);
  const ctx = buildContext({ id: "com.pet.probe", permissions: [] });
  await assert.rejects(() => ctx.secrets.set("apiKey", "v"), /权限被拒绝/);
  await assert.rejects(() => ctx.secrets.get("apiKey"), /权限被拒绝/);
  await assert.rejects(() => ctx.secrets.delete("apiKey"), /权限被拒绝/);
  assert.deepEqual(secretCalls(), [], `未授权却发了 IPC: ${JSON.stringify(secretCalls())}`);
});

test("已授权时三命令各发一次且带自己的 pluginId", async () => {
  resetStub();
  setReply("permission_check", true);
  setReply("secrets_get", "the-value");
  const ctx = buildContext({ id: "com.pet.probe", permissions: ["storage"] });
  assert.equal(await ctx.secrets.get("apiKey"), "the-value");
  await ctx.secrets.set("apiKey", "v");
  await ctx.secrets.delete("apiKey");
  assert.deepEqual(
    secretCalls().map((c) => [c.cmd, c.args.pluginId]),
    [
      ["secrets_get", "com.pet.probe"],
      ["secrets_set", "com.pet.probe"],
      ["secrets_delete", "com.pet.probe"],
    ],
  );
});

test("桥缓存了授权时，失效后必须重新问宿主", async () => {
  resetStub();
  setReply("permission_check", true);
  const ctx = buildContext({ id: "com.pet.probe2", permissions: ["storage"] });
  await ctx.secrets.get("apiKey");
  calls.length = 0;
  invalidatePermissions("com.pet.probe2");
  setReply("permission_check", false);
  setReply("permission_request", false);
  await assert.rejects(() => ctx.secrets.get("apiKey"), /权限被拒绝/);
  assert.ok(calls.some((c) => c.cmd === "permission_check"), "失效后必须重新问宿主");
});
