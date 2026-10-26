# GOAT 用量（com.pet.goat-gauge）

Command Code GOAT 的额度与 token 用量看板，移植自
[langjinusi985360/goat-gauge](https://github.com/langjinusi985360/goat-gauge)（MIT）。

## 功能

- 5 小时 / 本周 / 本月三窗口额度环与重置倒计时（宠物旁 badge、桌面悬浮卡、插件页概览）
- 月度余额、缓存命中率与账期 KPI（请求数、成本、平均成本、成功率、输入/输出 tokens）
- 本地 48 小时额度趋势（每 5 分钟采样）
- 低额度 / 用尽 / 余额低 / 凭据失效告警：系统通知 + 宠物反应，按窗口 `reset_at` 去重
- 演示模式：固定种子、不出网，供设置页预览与 e2e 使用

## 数据源与权限

- 只访问 `https://api.commandcode.ai/alpha/{whoami,billing/credits,billing/subscriptions,usage/summary}`，
  用 `Authorization: Bearer <key>`。首次访问会弹一次 `http:api.commandcode.ai` 同意框。
- 凭据保存在本机插件隔离存储（secrets.json，Windows DPAPI 按当前用户加密）；完整 Key 不回传到界面，也不进 `:widget` / 日志。
- 出网收在 `index.js::out()`：串行闸门、400ms 最小间隔、20 次/分钟、429 冷却阶梯、
  传输层失败重试一次。宿主 `ctx.http.request` 不返回响应头，因此 `Retry-After` 不可用。
- 额度单位是 credits，不随币种换算；只有 cost 字段按 USD→CNY 汇率换算。

## 已知限制

- 宿主 `ctx.dom` 的 SVG 白名单没有 `stroke-width` 等呈现属性：圆环用 `path` 弧线，
  线宽/线帽/填充透明度写在 `<style>` CSS 里；刻度用 HTML span，不用 SVG text。
- 插件没有 `matchMedia` / 剪贴板能力：界面固定配色，studio URL 只显示文本。
- 上游 `/alpha/*` 是未公开接口，字段变化时靠 `normalize.js` 的多字段兜底。

## 验证边界

- `npm run verify:release` 只安装 `tests/fixtures/l1-probe` 等 L1 夹具，**不安装本插件**；
  它不能证明 goat-gauge 的 SVG / `<style>` 在打包版 CSP 下正常。
- 本插件当前的运行时验证是 `tests/e2e/verify-goat-gauge.mjs`（dev，Worker realm）；
  打包版 CSP 下的 SVG 渲染需要单独的夹具或 PM 本机人工检查，尚未覆盖。

## 许可证

MIT License

Copyright (c) 2026 langjinusi985360

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
