# 皮肤图集格式（v1 / v2 / v3）

桌宠图集由宿主 `petskin` 协议提供：`http://petskin.localhost/<slug>/sprite.webp`。
渲染层把图集切成「图集上的源矩形 + 单位化目标矩形」，不逐帧烘焙画布；所有帧共用同一份已解码图集。

## v1 / v2（现状：按尺寸识别）

- 8 列 × 9 行（v1）或 8 列 × 11 行（v2），单元格 192×208。
- 只凭图片尺寸识别（`src/pet/petdex-states.ts::detectSpriteAtlas`），不读任何清单。
- 行为与 D01 之前完全一致。

## v3（按清单触发）

v3 不由尺寸识别：只有图集同目录的 `pet.json` 里 `desktopPet.version === 3` 才启用。
清单文件固定是 `<图集目录>/pet.json`，与 `sprite.webp` 相邻。

### 清单结构

```json
{
  "desktopPet": {
    "version": 3,
    "grid": { "columns": 16, "rows": 8 },
    "states": {
      "idle": { "row": 0, "frames": 6, "durationMs": 1200 },
      "waving": { "row": 1, "frames": 4, "durationMs": 640 }
    }
  }
}
```

### 校验规则

| 项 | 规则 |
|---|---|
| `version` | 必须是数字 `3`；其他值按“没有清单”处理，不走 v3 |
| `grid.columns` | 必须是 `16` |
| `grid.rows` | 正整数；图高必须能被它整除 |
| `grid` 与图宽 | 图宽必须能被 `16` 整除 |
| `idle` | `states.idle` 必填 |
| 状态 id | 必须是九个状态之一：`idle / running-right / running-left / waving / jumping / failed / waiting / running / review`；未知 id 忽略并各警告一次 |
| `row` | 非负整数；状态占用的行区间是 `[row, row + ceil(frames / 16))` |
| `frames` | 整数 `1..64` |
| 行区间 | 必须在 `grid.rows` 内；任意两个状态不能相交（相邻允许） |
| `durationMs` | 整数；`durationMs / frames >= 16`；`durationMs <= 20000` |
| 图片尺寸 | 每边 `<= 8192`；`width * height * 4 <= 128 MiB` |

### 帧序

第 k 帧（从 0 起）位于：

- 行：`row + floor(k / 16)`
- 列：`k % 16`

例如 64 帧的状态占 4 行：第 17 帧在 `row + 1` 的第 0 列，第 64 帧在 `row + 3` 的第 15 列。

### 节奏

- `frameSec = durationMs / (frames * 1000)`：帧间隔，九个状态都生效。必须一次除法——先除 1000 再除帧数会引入二进制误差（`600/1000/12 = 0.049999999999999996`），而帧间隔是回归里逐字比对的判据。
- `cycleSec = durationMs / 1000`：整轮时长；手势（`waving` / `jumping` / `failed`）的停留时长用它。
- `idle`（9 秒）、`waiting`（长久）与循环类（45 秒续期上限）的停留仍是宿主行为参数，不由清单覆盖。

## 回退与容错

| 情况 | 行为 |
|---|---|
| 没有 `pet.json` | 按 v1/v2 尺寸识别，行为不变 |
| `pet.json` 不是合法 JSON / 空文件 | 按没有清单处理，走 v1/v2 |
| `desktopPet.version !== 3` | 按没有清单处理，走 v1/v2 |
| `version === 3` 但校验失败 | 程序生成占位帧 + `console.warn` 具体原因；不再回猜 v1/v2 |
| 读取 `pet.json` 超过 2 秒 | 当作没有清单 |
| 图集本身加载失败 | 程序生成占位帧（原有路径） |

未知状态 id 只忽略该状态，不影响清单其余部分；同一个 id 每次运行只警告一次。

## Windows 打包版与 CSP

- 目标平台是 Windows + WebView2；打包版页面 origin 是 `http://tauri.localhost`。
- `pet.json` 与图集同目录，通过相对 URL 读取；宿主 `src-tauri/src/services/skins/protocol.rs` 的 `SERVED_FILES` 已包含 `pet.json`，并对 `localhost` / `*.localhost` 来源反射 CORS。
- 打包版 CSP 的 `connect-src` 必须包含 `http://petskin.localhost`，否则 `fetch(pet.json)` 会被 CSP 拦掉。D01 按用户 2026-10-26 的选择（A）只追加这一个来源；`img-src` 的原有条目不变。
- dev 实例不注入 CSP，CSP 问题只能在 `tauri build` 产物上复现。

## 内存

- 单张图解码后上限 128 MiB（校验项）；图集缓存仍按 LRU 只留 2 份，理论最坏 `2 × 128 MiB = 256 MiB`。
- 参考量级（解码后，每像素 4 字节）：v1 1536×1872 ≈ 11.5 MB；本文示例 3072×2704 ≈ 33.2 MB（缓存两份约 66.3 MB）；
  36 行、每状态 64 帧的 3072×7488 ≈ 92 MB。
- v3 不新增逐帧画布：帧仍是源矩形，内存与 v1/v2 同一量级。
- 建议长序列只用在 idle 这类状态；素材用 1 倍或 1.5 倍，别把九个状态都做成 64 帧。

## 打包版人工验证（v3）

dev 实例不注入 CSP，必须用 `tauri build` 产物验证：

1. 先在设置页装一个画廊皮肤（生成 `%APPDATA%\com.desktoppet.pet\skins\<slug>\meta.json` 与 `sprite.webp`），然后退出应用。
2. 把 v3 的 `sprite.webp` 覆盖到该目录，并把 `pet.json` 放在同一目录。
3. 启动打包版，选择该形象：`idle` 按清单的 48 帧 / 2 秒循环，`waving` 按 12 帧 / 0.6 秒播完回 idle；
   切换系统显示缩放后帧不变形。
4. 若把 `pet.json` 改成非法（例如 `grid.columns: 8`），应看到程序生成的橙色占位宠物，且 WebView 控制台有
   `[pet] v3 清单无效，退回程序生成占位帧: …` 的具体原因。
5. 内存：任务管理器里看该窗口的 WebView2 子进程；本文示例皮肤加载前后涨幅应在约 33 MB 量级，
   缓存两张时最坏不超过 2 × 128 MiB。
