# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.3] - 2026-06-17

SKILL.md Confirmation Policy + 修 permissions.test.ts CI 在 Ubuntu 全挂的 bug。

### Fixed

- **permissions.test.ts 在 Ubuntu CI 全挂**（4 个测试）：测试 mock 了 `node:os.platform()` 但 `permissions.ts` 用的是 `process.platform` 直接检查，mock 无效。Ubuntu 上 `checkAccessibility` 走非 darwin 分径直接 return true，osascript 从不被调用，断言失败。fix：用 `Object.defineProperty(process, "platform", ...)` stub 为 darwin。
- 最近 3 个 commit（v0.6.0→v0.6.2）CI 都因此挂——之前本地 macOS 通过掩盖了问题。

### Added

- **Confirmation Policy**（SKILL.md）：参考 Codex computer-use skill，给 ucu-mcp skill 补安全确认策略节。3 级分类：always-confirm（删除/发送/支付/账户/系统设置/敏感数据）/ confirm-unless-preapproved（登录/上传/安装）/ no-confirm（读取/下载/cookie）。ucu-mcp v0.6.0+ 后台操作能力意味着 agent 能静默操作用户看不到的窗口，比前台操作更需谨慎。

## [0.6.2] - 2026-06-17

修 `normalizeAppName` 名字匹配 bug + 清理死代码 + 补 TTL 测试。

### Fixed

- **selectWindowForApp 名字匹配 bug**（`helpers.ts`）：`normalizeAppName` 只做 `trim().toLowerCase()`，导致 `"cc-switch"`（用户输入）无法匹配 `"CC Switch"`（`NSRunningApplication.localizedName`）。fix：drop 所有非字母数字字符（`.replace(/[^a-z0-9]/g, "")`），所有变体归一化到 `"ccswitch"`。之前 `focus_app("cc-switch")` 因名字 mismatch 退到 tray fallback，误诊为 per-process 失效。
- **appNameMatches 死代码清理**：去掉 startsWith/includes 带空格的条件（normalize 后无空格，永不命中），改为 includes 双向匹配。

### Added

- **denied/granted TTL 时效测试**（`permissions.test.ts`）：用 fake timers 验证 denied 1s / granted 5s 后 cache 失效重查（之前 Sync 73 记录说写了但未 commit）。

### 真机验证

- per-process 对 ZCode（原生 SwiftUI）完全生效：click(735,478) 返回 dispatch:per-pid，Warp 始终前台不被抢。

## [0.6.1] - 2026-06-17

响应流程并行化 + 短期缓存，降低 describe_screen / screenshot(describe) / focus_app 延迟。

### Changed

- **并发收集 describe_screen 4 源**：OCR + AX + foreground + screen 用 `Promise.all` 并发（之前串行）。
- **并发 getSafetyContext**：listWindows + browser context 并行。
- **并发 screenshot + describe**：`screenshot(describe:true)` 的截图和描述生成并行。
- **listWindows in-flight 去重**：并发请求共享同一个 promise，避免重复 windowlist-helper 子进程。
- **getScreenSize 实例缓存**：5s TTL。

### Added

- **permission check cache**（`permissions.ts`）：granted 5s / denied 1s TTL。denied 短 TTL 让用户授权后快速生效。
- **AXPress spin 可调**：80ms→50ms 默认，env `UCU_AXPRESS_SPIN_MS` 可调（max 80ms）。

### Tests

- permission cache 测试、AXPress spin timing 测试。326 passed。

## [0.6.0] - 2026-06-17

对标 Codex 原生 computer use：输入注入走 per-process 路径，不移动全局光标、不抢前台。仅 Mac 端（与 Codex mac 版一致，Win 版只前台）。

### Added — 核心后台能力

- **skylight-helper（native/skylight/main.swift）**：第 4 个 Swift native helper。dlopen SkyLight.framework，`SLEventPostToPid`（私有 SPI）按 PID 投递鼠标事件——绕开全局 HID 流，光标不动。完整 cua-driver 配方：NSEvent bridge 构建（绕开 Chromium renderer 过滤）+ field 40 pid latch + `CGEventSetWindowLocation` + focus-without-raise（`SLPSPostEventRecordTo` 248-byte event record，不调 `SLPSSetFrontProcessWithOptions`）+ (-1,-1) primer 欺骗 Chromium user-activation gate。键盘走公开 `CGEventPostToPid`。frontmost/canvas app 自动 fallback HID-tap。
- **pid/windowNumber 透传链**：`WindowInfo`/`AppTarget` 加 `windowNumber`（真实 CGWindowID，window.ts 原本丢弃了）。`macos/input.ts` 读 `activeTarget` 透传到 `utils/input.ts`。`utils/input.ts` 函数加 `target` 参数，pid>0 走 skylight-helper，否则 fallback cgevent-helper（HID-tap）。
- **AX 保活（方向4b 根因修复）**：skylight-helper 的 `keepAlive` 命令写 `AXManualAccessibility`/`AXEnhancedUserInterface` + 订阅 remote-aware AX observer（`_AXObserverAddNotificationAndCheckRemote`，符号缺失时 fallback 公开 API）。focusApp 成功后调用，保活目标 AX 树（被遮挡的 Electron/Tauri 不再冻结 → AXPress 不再静默失败）。
- **tray per-process**：`MenuBarExtraItem` 加 `pid` 字段，findMenuBarExtra 捕获 SystemUIServer pid。focusApp 建 tray target 时用真实 host pid（非 0），tray 坐标点击也走 per-process。
- **dispatch 信号透出**：所有输入工具返回 `result.dispatch`（`"per-pid" | "hid-tap"`）。hid-tap 时附 warning。doctor 检测 skylight-helper 可用性。
- **DispatchMethod 类型**（base.ts）：Platform 接口 mouse/keyboard 方法返回 `Promise<DispatchMethod | void>`。

### Changed

- **element.ts 坐标 fallback 迁移**：`JXA_COORDINATE_CLICK`（JXA HID-tap）重命名为 `JXA_BOUNDS_CENTER`（只算中心坐标）。clickElement/clickMenuBarExtra 的坐标点击退出 JXA，改在 TS 层调 `this.click()`（走 per-process）。
- SKILL.md：加 "Dispatch method (v0.6.0+)" 节 + Operating Rules 加 "focus_app before input"。

### 真机验证（2026-06-17）

- ✅ skylight-helper ping 返回 `{"ok":true,"skylight":true}`（SPI 全加载）。
- ✅ 对后台 Finder pid click(100,100) 返回 `method:per-pid`，光标不跳到 (100,100)（HID-tap 会直接跳过去）——核心承诺验证。
- ✅ keepAlive 对 Finder pid 返回 `method:ax-keepalive`。
- ✅ 310 tests passed（4 native helpers 全编译）。

### 已知限制

- Canvas/GPU app（Blender/Unity/游戏）的 event loop 只接受 HID-tap → 自动 fallback，返回 `dispatch:"hid-tap"` + warning。
- `_AXObserverAddNotificationAndCheckRemote` 符号在本机未通过 dlsym 解析（remote:false），但 AXManualAccessibility/AXEnhancedUserInterface 属性写入生效（覆盖非 Chromium 场景）。

## [0.5.2] - 2026-06-17

Agent Skill 重写为 CLI agent 优先（Claude Code / Codex / OpenCode 都是 stdio CLI 环境）。

### Changed

- **SKILL.md 重写**：Core Workflow 改为"决策循环"状态机视角（observe → decide → act → verify），强调 CLI agent 每次工具调用无状态、必须每次重新观察。新增"Reading click results"表（v0.5.1 的 method/verified 信号解读：axpress+true 放心走 / axpress+false 复核 / coordinate+false 必须重新观察）。工具选择改为 AX-first / vision-fallback / tray 三分法。Operating Rules 第一条改为"Re-observe before every action"。
- **workflows.md 重写**：所有 playbook 改为 CLI 可执行序列（每步读响应再决定下一步）。cc-switch playbook（#2）补充真实 gotcha：click_menu_bar_extra 打开的是原生应用菜单（About/Hide/Quit），"使用统计"在 WebView 设置窗口内；托盘菜单在独立调用间会自动关闭，必须用 captureAfter 单次捕获。新增 workflow #6（verify click 结果）和 #8（卡住时的诊断顺序）。
- **troubleshooting.md**：新增"Click result signals (v0.5.1+)"节，解释 method/verified 不是错误而是置信度信号。
- **README** Agent Skill 节：明确"为 CLI agent 编写"。

### 真机验证（按重写后的 skill workflow 重跑）

- ✅ doctor ready / focus_app(cc-switch) 建 tray target / click_menu_bar_extra 返回 method:axpress verified:true。
- ✅ 验证了 skill 的核心价值：workflow #2 的 gotcha 指引正确诊断出 cc-switch 托盘菜单只有 About/Hide/Quit（原生应用菜单），"使用统计"需开 WebView 设置窗口。
- ⚠️ 发现真实 CLI 痛点：cc-switch 托盘菜单在独立 ocr 调用间自动关闭（失焦即关），必须用 captureAfter 在单次 click_menu_bar_extra 调用里捕获——这正是 skill 新 workflow #6 强调的"单次调用捕获"模式。

## [0.5.1] - 2026-06-16

方向4b AXPress verify-then-fallback + 方向5 FocusStealSuppression @deprecated 文档化。

### Added

- **方向4b AXPress verify-then-fallback（clickElement + clickMenuBarExtra）**：解决 Tauri/Electron 控件静默吞 AXPress（不抛异常也不执行）。双层策略：(1) 启发式跳过——对已知静默吞的应用（`AX_SILENT_APP_HINTS = ["tauri"]`，按 appName includes 匹配）直接坐标点击，跳过 AXPress；(2) verify 状态签名——对走 AXPress 的应用，采样前后 `value|focused|selected` 签名，spin 80ms 等异步生效，无变化则降级坐标。`ClickResult { method: "axpress"|"coordinate"; verified: boolean }` 透到 ActionReceipt.result，verified:false 时附 warning 引导模型用 screenshot/get_window_state 复核。无可观测状态的元素（纯按钮）保守判 verified:false 但不降级坐标（避免误伤）。共享 JXA 原语 `stateSignature`/`coordinateClick`/`spinMs`。
- 返回类型波及链：`clickElement`/`clickMenuBarExtra` `Promise<void>` → `Promise<ClickResult>`（base.ts 接口 + windows/linux stub + element.ts consumer + tools-layer mock）。

### Changed

- **方向5 FocusStealSuppression @deprecated 文档化**：`focus.ts` 的 `saveFocus`/`restoreFocus` 加 `@deprecated` JSDoc，说明 CGEvent 在 HID 层工作不需前台 focus、焦点管理被有意禁用、`tools-layer.test.ts` 的 `not.toHaveBeenCalled()` 锁定禁用态。不删不接线（文档化设计决策，非遗漏）。`base.ts` 接口注释同步。

### Fixed

- 无行为修复（4b/5 是 v0.5.0 的质量强化）。

### 真机验证（2026-06-16）

- ✅ doctor 全绿（3 native helpers + 权限 + 26 工具）。
- ✅ OCR（方向1）返回非空 elements，无 NSNull 崩溃。
- ✅ press_key 字母键 Cmd+M（方向2）成功合成，不报 Unknown key。
- ✅ describe_screen（方向3）结构正确，AX 失败时聚合到 errors[] 不抛出。
- ✅ focus_app(cc-switch)（方向4a）建立 tray target（windowId:"tray"），不抛 WINDOW_NOT_FOUND。
- ✅ click_menu_bar_extra（方向4b）返回 `method:"axpress", verified:true`——托盘菜单真实打开（OCR 确认 "About/Hide/Quit CC Switch" 菜单项可见）。
- ⚠️ 发现：cc-switch 托盘菜单是其**原生应用菜单**（About/Hide/Quit），"使用统计"在 WebView 设置面板内，不在托盘菜单。完整 "设置→使用统计" 流程需先打开设置窗口（非托盘菜单可达），留 follow-up。

### Tests

- 303→310（+7：clickElement ClickResult 解析、JXA stateSignature/spinMs/coordinateClick/sigBefore/sigAfter/preferCoord source 断言、Tauri 启发式 preferCoord=true、tools-layer method/verified 透出 + warnings）。

## [0.5.0] - 2026-06-15

cc-switch 操控诊断与视觉通道修复：打通 OCR + 字母快捷键 + 托盘 + 视觉降级 fallback + 内置 agent skill。

### Added

- **方向3 `describe_screen` 工具 + screenshot `describe` 选项（25→26 工具）**：结构化文本屏幕描述（OCR blocks + AX tree + foreground window），是 image content 在中转环境被降级为 URL 时的视觉 fallback。OCR/AX 各自 try/catch，失败聚合到 `errors[]` 不抛出。密码字段（`AXSecureTextField` 或 name 匹配 `/password|secret|token/i`）自动脱敏为 `[REDACTED]`。`screenshot(describe:true)` 在 image block 后追加 text block；独立 `describe_screen` 工具纯文本无 image。新增 `ScreenDescription` 类型（`base.ts`）；`axDepth` 用 `Math.min(depth,10)` 与 ax-tree 一致；`ocrBlocks` 默认 50 cap。
- **方向4a `click_menu_bar_extra` 托盘支持 + SystemUIServer 遍历**：`findMenuBarExtra` JXA 两阶段——先查 app 自身 menuBarItems（`host:"self"`），为空或仅 Apple 菜单时追加遍历 `SystemUIServer` 进程托管的状态项（`host:"systemuiserver"`），按 description/name 双向 includes 匹配。`clickMenuBarExtra` 按 `host` 在正确进程重定位（SystemUIServer 顺序不稳定，按 name/description 二次匹配）。`MenuBarExtraItem` 加 `host` 字段。纯 LSUIElement 托盘应用现在可达。
- **Agent Skill 三层**：`skills/ucu-mcp/SKILL.md`（精简入口 + YAML frontmatter）+ `references/{tool-reference,workflows,troubleshooting}.md`（深度文档，按需读取）+ `agents/openai.yaml`（Codex 接口元数据）。随 npm 包发布（`files` 字段加 `skills/`）。可通过 `npx skills add ucu-mcp -g -a codex/claude-code` 安装。README 加 "Agent Skill" 节。
- `UCU_MCP_INSTRUCTIONS` 加 describe_screen 指引（image 不可见时的 fallback）。
- `OBSERVE_ACTIONS` 加 `describe_screen`（observe 类，不触发 user-activity pause）。
- 工具数断言 25→26 同步更新（tools-layer / cli-mcp / client-cli-smoke）。
- +19 测试：describe_screen（OCR/AX 失败聚合、ocrBlocks cap、密码脱敏 AXSecureTextField/token、ocr=false/includeAx=false）+ screenshot describe=true + SystemUIServer 遍历（source 断言 / host 字段 / click 重定位）。

### Fixed

- **方向1 OCR 路径修复（两 bug 叠加）**：`ocrNative` candidates 加 4 级 `../../../../native/ocr/ocr-helper`（npm prod 下 screen.js 在 4 级深，原 3 级候选全 MISSING）；`ocrJxa` 重写绕开 CGImage 脆弱路径（`VNImageRequestHandler.initWithURLOptions` + `Ref()` + `ObjC.unwrap` + 像素维度 `pixelsWide/pixelsHigh`），消除 `NSNull unrecognized selector` 崩溃。删 `ocrJxa` 死代码 `scaleFactorX`（`buf.readUInt32BE(16)` 在权限缺失时抛 RangeError 绕过 hint）。`window.ts` `resolveNativeHelper` 同源 4 级路径修复。
- **方向2 press_key 字母/数字键**：`typeText` 的 letterMap/digitMap 提升为模块级 `MAC_LETTER_KEY_CODES`/`MAC_DIGIT_KEY_CODES`；`pressKey` falsy-safe 三元回退（先特殊键 → 字母 `in` 判定 → 数字；用 `in` 防 `'a'`=0 穿透）。`keyboard-tools.ts` zod describe 更新（支持 a-z / 0-9）。
- **SafetyGuard blocklist 修正（方向2 引入的回归）**：字母 q 可解析后 `cmd+shift+q`（注销）绕过 blocklist（只有 cmd+q）。blocklist 加 `cmd+shift+q` + `cmd+option+q`；`normalizeShortcut` 加修饰键别名归一化（alt→option / ctrl→control / cmd→command）根治 `cmd+alt+esc` 绕过 `cmd+option+esc`。
- `findMenuBarExtra` JXA 进程名大小写/空格/连字符/下划线容差（`_norm`）；`matchMenuBarExtra` 无 selector 时过滤 Apple 菜单；`clickMenuBarExtra` null deref 防护。

### Changed

- 工具数 24→26（+`describe_screen`、+`click_menu_bar_extra`）。README/index.ts 注释同步。
- `focus_app` 托盘回退建立 `windowId:"tray"` 的 activeTarget（pid:0），`validateActiveTarget` 对 tray 直接 return（不查 listWindows）。

## [0.4.3] - 2026-06-14

### Fixed

- `registerTool` 回调漏调 `registry.register(name)`，导致启动日志 `Registered tools count:0`。一行修复（行为无变化，24 工具始终正常注册到 MCP server）。

## [0.4.2] - 2026-06-13

### Security

- **JXA escaping unified (P0/P1)**: All 8 JXA code-injection sites that built strings via manual `.replace()` escaping now use `JSON.stringify()` for every interpolated value. Eliminates shell-substitution, backtick, newline, and AppleScript injection vectors across `restoreFocus`, `focusApp`, `getActiveBrowserContext`, `getWindowState`, `ocrJxa`, `findElement`, `clickElement`, `typeInElement`, `setElementValue`. (SEC-P0-1, SEC-P0-2, SEC-P1-2, SEC-P1-3, ERR-P1-6)
- **`isScreenLocked` fail-closed (P1)**: Previously returned `false` when the `ioreg` check threw, letting actions proceed on a potentially locked screen. Now returns `true` on error so actions are blocked until lock state can be confirmed. (ERR-P1-4)
- **Window-skip / URL blocklist guards activated (P1)**: `SafetyGuard`'s `windowTitle` and `url` checks were dead code because no tool handler passed those fields. New `getSafetyContext()` helper resolves both from the active target and is spread into all 11 action tools' `withSafety` params. (SEC-P1-1)

### Fixed

- `listApps` and `listWindowsJxa` now wrap their `osascript` calls in `try/catch` and rethrow via `rethrowAccessibilityError`, so a permission failure surfaces as `PermissionError("accessibility")` with a recovery hint instead of a generic `PlatformError`. (ERR-P1-3)
- `getScreenSize` logs the failure and returns an `{ estimated: true }` flag on the fallback `1920x1080` value, instead of silently returning a default that callers cannot distinguish from a real measurement. (ERR-P1-5)

### Changed

- **`macos.ts` split into 10 domain modules**: The 1995-line monolith is now `base.ts`, `helpers.ts`, `focus.ts`, `screen.ts`, `window.ts`, `ax-tree.ts`, `input.ts`, `element.ts`, `clipboard.ts`, `index.ts` under `src/platform/macos/`. `base.ts` defines the class and re-binds methods; all `(this as any)` casts removed.
- **`tools.ts` split into 7 domain modules**: The 908-line tool registry is now `helpers.ts`, `screen-tools.ts`, `input-tools.ts`, `keyboard-tools.ts`, `element-tools.ts`, `app-tools.ts`, `index.ts` under `src/mcp/tools/`. A `ToolRegistry` class + `registerTool` callback pattern replaces the flat registration.
- **JXA helper templates extracted**: New `src/platform/jxa-helpers.ts` (216 lines) centralizes the `childElements`, `resolveElementByFullPath`, `resolveElementInApp`, `elemString`, `getBounds`, `isVisible`, `descriptorMatches`, `scoreEquivalent`, `refetchEquivalent` JXA functions. `element.ts` and `ax-tree.ts` now import and interpolate these instead of inlining 3× duplicated copies.
- `FindElementResult` type now has formal `subrole?: string` and `identifier?: string` fields; the `as any` casts that read them are gone.

### Tests

- 279 tests pass (13 unit + 2 integration), 12 skipped (2 GUI smoke suites gated by env vars). +34 new security tests: clipboard injection patterns (shell substitution, backtick, chaining, piping, JXA/AppleScript injection), permission-denied paths for all AX element tools, and platform-method integration coverage.
- Verified on Node v22.22.3 / macOS 26.6 (arm64). `npm run build` compiles 3 native Swift helpers.

## [0.4.1] - 2026-06-11

### Changed

- `UcuError` base class now has a formal `hint?: string` field with serialization in `toJSON()`. Platform errors that carry remediation hints (e.g. `WindowNotFoundError` from `focusApp` for Electron apps) now pass the hint through the constructor instead of using duck-type property assignment. (Fox 0.3.8 M1)
- `findElementInputSchema` export annotated with `@internal` — not part of the public API, may change without semver bump. (Raman 0.3.7 M4)
- `list_windows` empty-result branch now uses the top-level `checkPermission` import instead of a per-call dynamic `import()`. (Fox 0.3.8 M2)
- `doctor` `tried` arrays are now `readonly string[]` and no longer silently truncated via `.slice(0, 3)`. (Fox 0.3.8 N2/N3)
- Text-side and value-side regex pre-validation tests consolidated into a single `it.each` parameterized case. (Raman 0.3.7 N2)

### Fixed

- `find_element` now attaches a pixel-level fallback hint when it returns 0 results AND `scannedCount === 0` for a specific app (meaning the AX tree is empty — common with Electron/Chromium apps). The hint directs the model to use `screenshot` + `ocr` + `click(x, y)` instead of retrying `find_element` forever.
- CHANGELOG 0.3.7 `prepublishOnly` description now matches the actual script (`npx vitest run tests/unit/ && npm run build` instead of `npm test && npm run build`). (Raman 0.3.7 M2)
- CHANGELOG 0.3.7 scope claim "corrected in both `src/platform/macos.ts` and this CHANGELOG" narrowed to "corrected in this CHANGELOG" — the source file was already correct. (Raman 0.3.7 M3)
- CHANGELOG 0.3.5 duplicate "three fewer" / "two fewer" entry cleaned up — only the corrected "two fewer" version remains. (Raman 0.3.7 N4)
- Test comment "modern V8" clarified to "Node >= 12 / V8" for the all-no-bounds near-sort test. (Raman 0.3.7 N1)

### Tests

- 225 unit tests pass (13 test files).
- `macos`: value-side and text-side regex pre-validation tests consolidated into single `it.each` with preserved regression context.
- Verified on Node v22.22.3 / macOS 26.6 (arm64).

### Fixed

- **JXA return values fixed (P0)**: Three JXA scripts (`click_element`, `type_in_element`, `set_value`) called `JSON.stringify({success:…})` as a bare statement — the result was computed but discarded, so the osascript output was empty and `JSON.parse(out)` would fail or return undefined. Now each script assigns to `_result` and calls `JSON.stringify(_result)` once at the end.
- **Rate-limit timestamp ordering (P0)**: `lastActionTime` was updated before the user-activity pause check. If the pause blocked the action, the rate-limit window was consumed anyway, causing subsequent retries to also be rate-limited. Now `lastActionTime` is set only after both checks pass.
- **Window cache concurrency guard (P0)**: `listWindows` could be called concurrently (e.g. `validateActiveTarget` + `list_windows` tool). Two overlapping calls could write `windowCache` at the same time, producing torn reads. Added `windowCacheInFlight` flag — concurrent callers return stale data instead of racing.
- **`validateActiveTarget` checks pid (P1)**: Previously only checked windowId, missing the case where an app restarts and the OS reuses the same window ID. Now also checks pid match.
- **`focusApp` failure clears stale target (P1)**: When `focusApp` threw `WindowNotFoundError`, the old `activeTarget` was retained. Subsequent AX tools would try to use the dead target. Now `activeTarget` is cleared on failure.
- **`get_screen_size` goes through `withSafety` (P1)**: Was the only tool that bypassed the safety/permission/retry pipeline. Now wrapped in `withSafety` for consistent error handling and rate limiting.

### Tests

- 225 unit tests pass (13 test files).
- MCP stdio smoke: `doctor`, `list_windows`, `list_apps`, `get_screen_size` all return valid responses.
- All 3 JXA scripts now produce valid JSON output (verified via stdio pipe test).


## [0.3.8] - 2026-06-08

### Fixed

- `focus_app` no longer trips the user-activity pause. It used to be classified as `"other"` (neither observe nor input) so a recent mouse movement could block `focus_app` for 2 s; it is now in `OBSERVE_ACTIONS`, matching the production `withSafety` default. Symptom: OpenCode could not switch the active target app (e.g. CC Switch) without retrying until the cursor had been still for 2 s.
- `doctor` native-helper path resolution now checks `process.argv[1]` (npm / npx / global install), walks `import.meta.url` up to 4 levels, and falls back to `npm root -g`. Previously, when the MCP client launched `ucu-mcp` from a cwd other than the project root (the common case for `npx ucu-mcp`), the helper binaries would report as missing even though they were in the tarball. The new report includes `path` and a `tried[]` list so the model can see what was checked.
- `doctor` recommendations now list each missing macOS permission on its own line, name the host terminal app (so the user knows which entry to grant in System Settings), and add an Electron AX hint for the common case where `list_windows` returns `[]` even with Accessibility granted.

### Tests

- `safety-guard`: `focus_app` is in `OBSERVE_ACTIONS`; `classifyAction("focus_app") === "observe"`; `withSafety`'s default `skipUserActivityPause` lets the call through even mid user-activity.
- `errors`: `WindowNotFoundError` preserves an inline `hint` field set by the platform layer, surfaced in the MCP error response.
- `macos-platform`: OCR JXA `"Failed to load screenshot image"` is re-thrown as `CaptureError` with a hint pointing at the missing Screen Recording permission (the typical cause is `screencapture` writing a 0-byte file when TCC denies Screen Recording, not the helper binary being absent).
- `tools-layer`: `doctor` report carries `terminalApp` and the richer `nativeHelpers = { cgevent, ocr } = { ok, path, tried[] }` shape.

## [0.3.7] - 2026-06-07

### Fixed

- `find_element` value-schema test is no longer a tautology. The 0.3.6 release fixed a *symptom* of the bug (the old test called `handler()` directly, bypassing the McpServer schema-validation wrapper, and then asserted `r.isError === true` which was `undefined`); the underlying tautology remained: the test re-created a local `z.string().min(1).optional()` instead of exercising the real schema. 0.3.7 exports the actual `findElementInputSchema` from `src/mcp/tools.ts` and the test now imports it via `findElementInputSchema.value`, so the assertion genuinely pins the production schema. Pins the 0.3.2 commit `46d4ddd` semantic.
- CHANGELOG/JXA `textMatches` comment math is now correct: 3 sources → 1 RegExp = **2 fewer** compilations per matched element. The 0.3.5/0.3.6 wording "three fewer" was off by one and has been corrected in this CHANGELOG (the `src/platform/macos.ts` comment was already correct at that point).

### Tests

- `macos-platform`: text-side regex pre-validation now has a regression test mirroring the existing value-side test (`findElement({text:"[", textMode:"regex"})` throws `PlatformError` with an `Invalid regex pattern` message). Pins the original text-side guard that the 0.3.2 commit mirrored onto the value side.
- `macos-platform`: all-no-bounds edge case for the `near` sort — when every result is missing `bounds`, the original JXA order is preserved. Pins the 0.3.2 commit `0710eca` no-bounds fallback against a future refactor that introduces a non-stable comparator.

### Hygiene

- `findElementInputSchema` is now a named export from `src/mcp/tools.ts` (with a JSDoc comment explaining why the schema is exported) so the unit test can assert the production schema directly instead of constructing a local copy.
- Added `prepublishOnly` script to `package.json` that runs `npx vitest run tests/unit/ && npm run build` before `npm publish`. This is a structural guard against the yank rhythm that hit 0.3.3 and 0.3.5: a failed test or build will now block the publish at the npm level, not at the human level. (Raman review Minor #3)

## [0.3.5] - 2026-06-06  *(Yanked — see 0.3.6)*

### Tests

- `macos-platform`: new regression test for the value-field regex pre-validation (`findElement({value:"[", textMode:"regex"})` throws `PlatformError` with an `Invalid regex pattern` message). Pins the 0.3.2 commit `0710eca` behavior change.
- `macos-platform`: new regression test for the near-sort bounds fallback (elements without `bounds` are pushed to the end of the sorted result, instead of implicitly being centered at (0,0)). Pins the 0.3.2 commit `0710eca` second behavior change.
- `tools-layer`: new regression test that `find_element({value:""})` returns `isError: true`. Pins the 0.3.2 commit `46d4ddd` schema tightening (`z.string().min(1).optional()`).

### Changed

- JXA `textMatches` regex branch now compiles the `RegExp` once per element instead of once per source (name / value / description) — **two** fewer compilations per matched element when `textMode="regex"` (corrected in 0.3.7; 0.3.5/0.3.6 said "three fewer" which was off by one: 3 sources → 1 regex = 2 saved). The TS-side pre-validation in `findElement` guarantees the pattern is valid, so the `RegExp` constructor cannot throw here. (Herschel review perf Minor)

### Fixed

- Comment on the JXA `matchesValue` helper no longer claims "JXA function declarations are order-sensitive" (they aren't — JXA hoists them like any ES engine). The comment now correctly notes that the leading placement is for readability. (Herschel review comment Minor)

## [0.3.6] - 2026-06-06

### Re-publish of 0.3.5

0.3.5 was published with a test that didn't account for the McpServer
schema-validation wrapper. The test called `handler({value:""})`
directly, which bypasses the schema validation, so the assertion
`r.isError === true` saw `undefined` instead. The actual fix
(asserting the zod schema constraint directly) was a one-test rewrite;
0.3.6 carries the same code as 0.3.5 plus the test fix.

### Yanked

`ucu-mcp@0.3.5` was unpublished (yanked) within minutes of release
due to the broken test. Users on `@latest` are now on 0.3.6.

## [0.3.4] - 2026-06-06

### Re-publish of 0.3.3

0.3.3 was published with a syntax error in the source test file
(`tests/unit/tools-layer.test.ts:355` was a continuation of a `//`
comment block that lost its `//` prefix on a hard line break, so
tsc parsed the second line as a bare identifier). The published
npm tarball was functionally correct (`dist/` was unaffected), but
the broken test file would fail to compile for any consumer
running `npm test` against the source. The fix (a single-character
comment prefix) was applied, but npm disallows re-publishing the
same version, so the fixed source ships as 0.3.4 with the same
contents and CHANGELOG entry as 0.3.3 plus this note.

### Yanked

`ucu-mcp@0.3.3` was unpublished (yanked) shortly after release due to
the test file compile error. Users on `@latest` are now on 0.3.4.

## [0.3.3] - 2026-06-06  *(Yanked — see 0.3.4)*

### Tests

- `tools-layer`: three new test cases cover `wait_for_element` value+textMode combinations (contains, exact, regex). They confirm the response surfaces the matched value unchanged so the model can branch on it. (Completes Singer Item 4)

### Refactor

- JXA `textMatches` and `valueMatches` consolidated through a shared `matchesValue(filter, value, mode)` helper. No behavior change; the three branches (contains / exact / regex) now live in one place. (Completes Singer Item 8)

## [0.3.2] - 2026-06-06

### Bug fixes

- `find_element` with `textMode="regex"` now pre-validates the `value` field for invalid regex patterns and throws `PlatformError`, mirroring the existing `text`-field validation. Before, an invalid value regex was silently swallowed by the JXA-internal `try/catch` and surfaced as "no results" instead of a clear error. (Singer Minor)
- `find_element` `near` sort now explicitly pushes elements without `bounds` to the end of the sorted result, instead of implicitly treating them as centered at (0,0). Improves semantics for elements without on-screen geometry. (Singer Nit)

### Changed

- `find_element.value` schema is now `z.string().min(1).optional()`. Empty strings are now rejected at the schema layer with a clear validation error rather than being silently coerced to "no filter". (Singer Minor)

### Tests

- `macos-platform`: the `index out of range` test now also pins `metrics.matchedCount` to the JXA return value, locking the semantic that out-of-range indexing does not change the underlying match count. (Singer Minor)

### Tool description

- `find_element` tool description expanded to mention `value` / `index` / `near` selector support, so the model sees the new selectors at the tool level rather than only on individual parameters. (Singer Minor)
- `UcuError.defaultCode` lookup now has a JSDoc cross-reference explaining the relationship between the static class default and the per-instance `code` field. (Singer Minor)

### Hygiene

- Tracked 7 files removed from git tracking: `.codex/{config.toml,postmortem-interrupt-loop.md}`, `.claude/{settings.json,settings.local.json,.cozempic-init.lock}`, `docs/{.DS_Store,superpowers/.DS_Store}`. These were local-environment residue that predated the `.gitignore` rules; the ignore rules were already in place, just not enforced on the existing tracked entries. `claude-desktop-config.json` (the root-level sample for Claude Desktop MCP setup) was kept.

## [0.3.1] - 2026-06-06

### Bug fixes

- `wait_for_element` `until="value_change"` mode no longer spins until timeout when the matched element's initial `value` is `undefined` (e.g. progress indicators / status text without an AX value). A separate `hasInitial` flag now tracks "first sample captured" so a captured `undefined` is preserved as the baseline. On timeout, `value_change` mode now reports `"never_appeared"` (no match ever found) vs `"value_unchanged"` (match found but value did not change) so the model can branch on the result. (Singer review Major fix)

### Note

Post-0.3.0 release changes already merged on `main` and folded into 0.3.1:

- Scenario-based MCP `instructions` covering forms, menu bar, screen read, app switch, verify action, wait for UI, recover from `TARGET_STALE`, clipboard read/write. (47dbcff)
- `find_element` multi-strategy: new `value` (textMode-aware), `index` (Nth match), `near` (distance-sorted) selectors. (47dbcff)
- `wait_for_element` `until` parameter: new modes `appear` (default), `disappear`, `value_change`. (47dbcff)
- `UcuError` class static `code` renamed to `defaultCode` to avoid clashing with the instance `code` field. (eec7afd)

## [0.3.0] - 2026-06-06


### Added

- Scenario-based MCP Instructions — tool-usage guidance organized by task pattern (form fill, menu bar click, screen read, app switch, verify action, wait for change, recover stale target, clipboard)
- findElement multi-strategy: `value` filter (AX value, respects textMode), `index` selector (0-based Nth match), `near` sorter (ascending distance to point)
- wait_for_element `until` parameter: `appear` (default), `disappear` (poll until gone), `value_change` (poll until first match value differs)
- Action Receipt v1 — unified receipt structure for all action-class tools (click, double_click, scroll, drag, move, type_text, press_key, click_element, set_value, type_in_element)
- Receipt fields: actionId (base36-timestamp unique ID), action, status (ok/partial/blocked), target (location context), result (business result), capture (screenshot metadata), warnings, next (suggested next step)
- Partial receipt when action succeeds but post-action screenshot fails: status="partial", capture.error contains error details, warnings includes "Post-action screenshot capture failed"
- Target Session v1 — `focus_app` now returns stable target metadata (`targetId`, `appName`, `pid`, `windowId`, `title`, `capturedAt`) for follow-up tool calls
- `TARGET_STALE` structured errors for active target windows that disappear before `get_window_state`

### Changed

- MCP instructions rewritten from generic description to scenario-driven workflow recommendations
- `wait_for_element` description updated to reflect `until` parameter semantics
- `find_element` schema extended with `value`, `index`, `near` parameters
- Action tool responses now wrap business results under `result` instead of returning them at the top level
- captureAfter failures now surface through receipt.capture.error instead of a flat captureError object
- `get_window_state` can use the prior `focus_app` target when `windowId` is omitted
- AX tools (`find_element`, `wait_for_element`, `click_element`, `set_value`, `type_in_element`) can use the prior `focus_app` target when `app` is omitted

- Rewrote `src/mcp/tools.ts` with comprehensive 22-tool registry:
  - Unified `withSafety` wrapper for all automation actions
  - `captureAfter` helper for post-action screenshots
  - `windowId` guard for window-scoped operations
  - Integrated safety report in `doctor` output

### Security

- Security audit fixes applied:
  - Input validation on all tool parameters
  - Safe handling of file paths and URLs
  - Rate limiting considerations for rapid automation

### Architecture

- `ARCHITECTURE.md` rewritten to document:
  - FocusStealSuppression implementation
  - UserInteractionMonitor design
  - Safety layer architecture
  - Tool registry patterns

[0.1.0]: https://github.com/2876674942/ucu-mcp-backup/releases/tag/v0.1.0
