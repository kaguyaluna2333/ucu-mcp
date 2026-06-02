# UCU-MCP 测试体系设计

**日期**: 2026-05-29
**状态**: 已批准

## 背景

UCU-MCP 项目当前零测试覆盖。macOS 平台适配器和 MCP 工具层已实现，需要建立测试体系确保代码正确性和可维护性。

## 方案选择

采用**分层测试方案**：unit/integration 分离，vitest 框架。

## 目录结构

```
tests/
  unit/
    safety-guard.test.ts
    macos-platform.test.ts
    screenshot.test.ts
    input.test.ts
    tools.test.ts
  integration/
    macos-real.test.ts
```

## 配置

- `vitest.config.ts` — include `tests/**/*.test.ts`，ESM 模式
- `package.json` scripts:
  - `"test": "vitest run"`
  - `"test:watch": "vitest"`
  - `"test:integration": "vitest run --include tests/integration/**/*.test.ts"`
- `tsconfig.json` — include 添加 tests 目录

## Mock 策略

- `MacOSPlatform` / `screenshot.ts` / `input.ts` — mock `node:child_process` 的 `execFile` / `execFileSync`
- `ToolRegistry` — mock 整个 `Platform` 接口
- `SafetyGuard` — 纯逻辑，无需 mock

## 集成测试

- `macos-real.test.ts` 用 `describe.skipIf(!isMacOS)` 跳过非 macOS 环境
- 测试真实 screenshot、getScreenSize、getCursorPosition
- CI 自动跳过，本地手动运行

## 测试行为清单

### safety-guard.test.ts（纯逻辑，无 mock）

- 拦截禁止的按键组合（Cmd+Q、Cmd+W 等）
- 允许正常的按键通过
- 窗口跳过规则生效
- 速率限制触发时拦截
- 空输入/边界情况处理

### macos-platform.test.ts（mock node:child_process）

- `screenshot()` → 验证调用 screencapture 正确参数，返回 Buffer
- `screenshot(region)` → 验证区域截图参数 `-R x,y,w,h`
- `getScreenSize()` → 验证解析 JXA JSON 输出
- `getCursorPosition()` → 验证解析 CGEvent JSON 输出
- `click(x, y)` → 验证调用 createMouseAction().click()
- `type(text)` → 验证调用 createKeyboardAction().typeText()
- `scroll(x, y, dx, dy)` → 验证调用 createMouseAction().scroll()
- `key(keys)` → 验证调用 createKeyboardAction().pressShortcut()
- `drag(start, end)` → 验证调用 createMouseAction().drag()

### screenshot.test.ts（mock node:child_process）

- `captureFullScreen()` → 验证调用 `screencapture -x -t png`，返回 base64
- `captureRegion(x,y,w,h)` → 验证调用 `screencapture -R x,y,w,h -t png`
- 错误处理：screencapture 失败时抛出

### input.test.ts（mock node:child_process）

- `createMouseAction().click()` → 验证 osascript CGEvent 参数
- `createMouseAction().doubleClick()` → 验证两次 click 事件
- `createMouseAction().scroll()` → 验证滚动事件
- `createMouseAction().drag()` → 验证 mousedown→move→mouseup 序列
- `createKeyboardAction().typeText()` → 验证 keystroke 调用
- `createKeyboardAction().pressShortcut()` → 验证 key code + modifier

### tools.test.ts（mock Platform 接口）

- 9 个工具 handler 都调用正确的 platform 方法
- `screenshot` 返回 `{ type: "image", data, mimeType }` 格式
- 其他工具返回 `{ type: "text", text: JSON.stringify({...}) }` 格式
- platform 抛错时返回 `isError: true`
- SafetyGuard 拦截时返回拦截消息
- 参数正确传递（x/y/button/text/keys 等）

### macos-real.test.ts（真实调用，条件跳过）

- `screenshot()` 返回有效 PNG buffer（检查 PNG magic bytes）
- `getScreenSize()` 返回合理的分辨率（width > 0, height > 0）
- `getCursorPosition()` 返回非负坐标