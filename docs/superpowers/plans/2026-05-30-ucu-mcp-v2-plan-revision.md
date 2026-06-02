# UCU-MCP 工程计划 v2.1 修订实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修订 Obsidian 工程计划 v2.0 → v2.1，修正过时内容、不准确描述、砍掉低 ROI 模块、保留有价值的部分，并同步更新进度跟踪文件。

**Architecture:** 基于当前代码库实际状态（16 工具、CGEvent 后台注入、SafetyGuard 已修复），重新评估 v2.0 计划中的每个模块，保留高价值改进（SOM 元素索引、MCP Instructions、doctor 命令），砍掉低 ROI 项（virtual cursor overlay、capture_after、独立 CoordinateMapper 模块），修正不准确描述（工具数量、安全机制层数）。

**Tech Stack:** Markdown（Obsidian 格式）、UCU-MCP 项目上下文

---

## 文件结构

| 操作 | 文件路径 | 职责 |
|------|----------|------|
| 重写 | `/Users/kaguya/Documents/Obsidian Vault/Projects/Universal-Computer-Use-MCP/工程计划.md` | 主工程计划文档 v2.1 |
| 更新 | `/Users/kaguya/Documents/Obsidian Vault/Projects/Universal-Computer-Use-MCP/进度跟踪.md` | 同步 Phase 0 完成状态 |
| 更新 | `/Users/kaguya/Documents/Obsidian Vault/UCU-MCP项目/进度追踪.md` | 同步最新审计结果 |

---

### Task 1: 重写工程计划 v2.1 — 项目愿景与架构总览

**Files:**
- Rewrite: `/Users/kaguya/Documents/Obsidian Vault/Projects/Universal-Computer-Use-MCP/工程计划.md:1-50`

- [ ] **Step 1: 备份原文件**

```bash
cp "/Users/kaguya/Documents/Obsidian Vault/Projects/Universal-Computer-Use-MCP/工程计划.md" \
   "/Users/kaguya/Documents/Obsidian Vault/Projects/Universal-Computer-Use-MCP/工程计划-v2-backup.md"
```

Expected: 备份文件创建成功

- [ ] **Step 2: 重写文件头和项目愿景**

将工程计划.md 的前 50 行替换为：

```markdown
# UCU-MCP 工程计划 v2.1

> 更新日期：2026-05-30
> 基于 v2.0 修订：修正过时内容、砍掉低 ROI 模块、对齐实际代码库状态
> v2.0 备份：工程计划-v2-backup.md
> v1 备份：工程计划-v1-backup.md

---

## 一、项目愿景

构建一个 **跨平台（macOS / Windows / Linux）** 的 Computer Use MCP 服务器，让任何支持 MCP 协议的 AI 客户端（Claude Desktop、Cursor、Windsurf、Continue 等）能够通过自然语言控制用户电脑。

**核心差异化**（v2.1 修订）：
- **元素索引双模式**：find_element → click_element/type_in_element，优先元素操作，fallback 到坐标
- **CGEvent 后台注入**：所有输入操作（鼠标+键盘）均使用 CGEvent API，不抢焦点
- **三层安全机制**：硬拦截 + 注入检测 + 速率限制（已实现并修复）
- **MCP Instructions**（待实现）：initialize 时返回使用指导，引导 LLM 正确使用工具

**v2.1 vs v2.0 变更摘要**：
- 工具数量：16 → 保持 16（不合并为 5 个，LLM 对显式工具名发现性更好）
- 砍掉：virtual cursor overlay、capture_after、独立 CoordinateMapper 模块
- 简化：SOM 覆盖层 → 纯 JSON 元素列表；AppScope → activate + clipToBounds
- 修正：安全机制三层改为更实际的方案；postToPid 不引入 native addon
- 新增：doctor 命令提前到 Phase 1；MCP Instructions 实现方案
```

- [ ] **Step 3: 验证文件头写入正确**

```bash
head -30 "/Users/kaguya/Documents/Obsidian Vault/Projects/Universal-Computer-Use-MCP/工程计划.md"
```

Expected: 看到 v2.1 标题和更新日期 2026-05-30

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: 工程计划 v2.1 — 更新项目愿景和变更摘要"
```

---

### Task 2: 重写架构设计 — 工具 Schema 与安全机制

**Files:**
- Rewrite: `/Users/kaguya/Documents/Obsidian Vault/Projects/Universal-Computer-Use-MCP/工程计划.md:50-175`

- [ ] **Step 1: 替换架构图和工具 Schema 部分**

将工程计划.md 的 §2.1-2.3 部分（约第 50-175 行）替换为：

```markdown
## 二、架构设计（v2.1 修订）

### 2.1 整体架构

```
┌───────────────────────────────────────────────────────────────┐
│  MCP Server Layer                                             │
│  - 16 个独立工具（语义清晰，LLM 发现性好）                     │
│  - initialize 时返回 instructions（待实现）                    │
├───────────────┬───────────────┬───────────────────────────────┤
│  Safety Layer │  AX Layer     │  Platform Layer               │
│  硬拦截       │  AX 树遍历    │  macOS: CGEvent 后台注入      │
│  注入检测     │  元素索引     │  Windows: SendInput (stub)    │
│  速率限制     │  JSON 元素    │  Linux: xdotool (stub)        │
├───────────────┴───────────────┴───────────────────────────────┤
│  Input Layer                                                  │
│  - CGEvent 后台注入（不抢焦点）                                │
│  - Retina scaleFactor 检测（已实现）                           │
│  - JXA + CoreGraphics 调用                                    │
├───────────────────────────────────────────────────────────────┤
│  Vision Layer                                                 │
│  - 截图（screencapture CLI，已实现）                           │
│  - OCR（VNRecognizeTextRequest，已实现）                      │
│  - AX 树遍历（JXA System Events，已实现）                     │
└───────────────────────────────────────────────────────────────┘
```

### 2.2 工具 Schema（v2.1：保持 16 个独立工具）

**v2.0 计划合并为 5 个工具，v2.1 决定保持 16 个独立工具。理由：**

1. **LLM 发现性**：`click`、`type_text`、`screenshot` 等语义清晰的工具名，比 `computer_mouse(action="click")` 更容易被 LLM 理解和选择
2. **Token 效率**：独立工具名省去了 action 枚举的 token 消耗
3. **业界实践**：Anthropic 官方 computer-use 用 3 个独立工具（computer, text_editor, bash），不是 1 个判别器
4. **当前 16 个工具已稳定**：E2E 12/12 通过，无需重构

**当前 16 个工具清单：**

| # | 工具 | 分类 | 状态 |
|---|------|------|------|
| 1 | screenshot | Screen & Window | ✅ |
| 2 | list_windows | Screen & Window | ✅ |
| 3 | get_window_state | Screen & Window | ✅ |
| 4 | get_screen_size | Screen & Window | ✅ |
| 5 | ocr | Screen & Window | ✅ |
| 6 | click | Mouse & Input | ✅ |
| 7 | double_click | Mouse & Input | ✅ |
| 8 | scroll | Mouse & Input | ✅ |
| 9 | drag | Mouse & Input | ✅ |
| 10 | move | Mouse & Input | ✅ |
| 11 | get_cursor_position | Mouse & Input | ✅ |
| 12 | type_text | Keyboard | ✅ |
| 13 | press_key | Keyboard | ✅ |
| 14 | find_element | AX Element | ✅ |
| 15 | click_element | AX Element | ✅ |
| 16 | type_in_element | AX Element | ✅ |

**未来可选新增（Phase 2+）：**
- `set_value`：AXUIElementSetValue，操作下拉框/滑块/复选框
- `wait`：等待 UI 变化或指定时间

### 2.3 安全机制（v2.1：三层实际方案）

**v2.0 的 "审批门控" 在 MCP 场景下不实际——MCP server 无法弹审批 UI 给用户。**

**v2.1 三层方案：**

```
┌─────────────────────────────────────────────────────────┐
│  Layer 1: 硬拦截（不可绕过）                              │
│  - 阻止危险快捷键: cmd+alt+delete, cmd+shift+q          │
│  - 阻止危险命令: sudo rm, mkfs, dd if=, fork bomb       │
│  - 已实现: SafetyGuard.blockedKeys ✅                    │
│  - 已修复: press_key action 名匹配 ✅ (2026-05-30)      │
├─────────────────────────────────────────────────────────┤
│  Layer 2: 注入检测（新增）                                │
│  - type_text 内容扫描: 检测 shell 注入、JXA 注入         │
│  - 拦截: `; rm -rf /`, `$(malicious)`, backtick 注入    │
│  - 实现: 在 typeText() 入口添加正则检测                   │
├─────────────────────────────────────────────────────────┤
│  Layer 3: 速率限制（已实现）                              │
│  - 最小操作间隔 100ms                                    │
│  - 防止自动化脚本失控                                     │
│  - 已实现: SafetyGuard.rateLimitMs ✅                    │
└─────────────────────────────────────────────────────────┘
```
```

- [ ] **Step 2: 验证替换内容正确**

```bash
grep -n "v2.1" "/Users/kaguya/Documents/Obsidian Vault/Projects/Universal-Computer-Use-MCP/工程计划.md"
```

Expected: 看到多个 v2.1 标记

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "docs: 工程计划 v2.1 — 架构设计、工具Schema、安全机制修订"
```

---

### Task 3: 重写模块清单 — 砍掉低 ROI，保留高价值

**Files:**
- Rewrite: `/Users/kaguya/Documents/Obsidian Vault/Projects/Universal-Computer-Use-MCP/工程计划.md:175-290`

- [ ] **Step 1: 替换模块清单部分**

将 §2.4-2.7 和 §三 模块清单替换为：

```markdown
### 2.4 AX 树遍历 + 元素索引（保留，简化实现）

**v2.0 方案**：AccessibilityEngine + SOM 编号 + Canvas 覆盖层
**v2.1 方案**：简化为 JSON 元素列表，不需要视觉覆盖层

```
┌─────────────────────────────────────────────────────────┐
│  AccessibilityEngine (简化版)                             │
│                                                          │
│  1. get_window_state(windowId, depth)                    │
│     ├── JXA 遍历 AX 树（已实现，depth 3，50 元素上限）   │
│     ├── 返回 window + tree JSON                          │
│     └── 已有: macos.ts getWindowState() ✅               │
│                                                          │
│  2. find_element(query)                                  │
│     ├── 按 role/label 搜索元素（已实现）                  │
│     ├── 返回 {index, role, label, bounds, pid}          │
│     └── 已有: macos.ts findElement() ✅                  │
│                                                          │
│  3. click_element / type_in_element                      │
│     ├── 通过元素索引操作（已实现）                        │
│     └── 已有: macos.ts clickElement/typeInElement() ✅   │
│                                                          │
│  4. SOM 覆盖层（砍掉）                                   │
│     └── 理由: JXA 中绘制 Canvas 复杂度高，LLM 可通过     │
│         JSON 元素列表直接定位，不需要视觉编号             │
└─────────────────────────────────────────────────────────┘
```

### 2.5 坐标与 Retina（v2.1：简化为辅助函数）

**v2.0 方案**：独立 CoordinateMapper 模块
**v2.1 方案**：不需要独立模块，`get_screen_size` 已返回 `scaleFactor`

```typescript
// 只需要一个辅助函数，不需要独立模块
function logicalToPhysical(x: number, y: number, scaleFactor: number) {
  return { x: Math.round(x * scaleFactor), y: Math.round(y * scaleFactor) };
}
```

**理由**：
- 当前 `get_screen_size` 已返回 `{width, height, scaleFactor}` ✅
- 坐标转换只需 `Math.round(x * scaleFactor)`，不值得独立模块
- macOS CGEvent 使用逻辑坐标，screencapture 使用物理坐标——scaleFactor 已够用

### 2.6 App-scoped 操作域（v2.1：简化方案）

**v2.0 方案**：AppScope 模块 + postToPid（需要 node-ffi-napi native addon）
**v2.1 方案**：activate app + clipToBounds，不需要 native addon

```
┌─────────────────────────────────────────────────────────┐
│  AppScope (简化版)                                        │
│                                                          │
│  - activateApp(appName): JXA activate 命令               │
│  - clipToBounds(point, windowBounds): 确保坐标在窗口内    │
│  - 不使用 CGEventPostToPid（避免 native addon 依赖）     │
│  - 不使用 postEventToPid（JXA 无法直接调用）             │
│                                                          │
│  实现路径:                                                │
│  1. JXA: Application(appName).activate() 切换焦点        │
│  2. CGEvent 全局投送（当前方案）                          │
│  3. clipToBounds 确保不点到窗口外面                       │
└─────────────────────────────────────────────────────────┘
```

**理由**：
- `CGEventPostToPid` 需要 node-ffi-napi，引入 C++ 编译依赖
- 当前 CGEvent 全局投送对大多数场景够用
- activate + clipToBounds 能覆盖 90% 的 app-scoped 需求

### 2.7 砍掉的模块

| 模块 | 砍掉理由 |
|------|---------|
| virtual cursor overlay | LLM 不需要看到光标位置，它知道坐标 |
| capture_after | LLM 通常需要 "截图→操作→截图" 3 步，capture_after 不能压缩为 2 步；增加每个工具调用的复杂度 |
| ScreenshotMetadata | 当前 get_screen_size 已返回 scaleFactor，不需要独立 metadata 模块 |
| 独立 CoordinateMapper | 只需一个 Math.round 辅助函数 |

### 2.8 新增模块（v2.1）

| 模块 | 文件 | 优先级 | 说明 |
|------|------|--------|------|
| MCP Instructions | `src/mcp/instructions.ts` | P1 | initialize 时返回使用指导 |
| doctor 命令 | `src/bin/doctor.ts` | P1 | 权限 + 依赖检查，用户遇到的第一个障碍 |
| 注入检测 | `src/safety/injection.ts` | P1 | type_text 内容扫描，防止 shell/JXA 注入 |

---

## 三、模块清单（v2.1 修订）

### 已完成模块（2026-05-30 审计确认）

| 模块 | 文件 | 状态 |
|------|------|------|
| MCP Server + 16 工具 | `src/mcp/tools.ts` | ✅ 完整 |
| macOS CGEvent 后台注入 | `src/utils/input.ts` | ✅ 完整 + 修复 |
| macOS AX 树遍历 | `src/platform/macos.ts` | ✅ 完整 |
| macOS 元素操作 | `src/platform/macos.ts` | ✅ find/click/type_element |
| SafetyGuard | `src/safety/guard.ts` | ✅ 修复 |
| 权限检查 | `src/safety/permissions.ts` | ✅ 分级权限 |
| 截图 | `src/utils/screenshot.ts` | ✅ Retina 支持 |
| OCR | `src/platform/macos.ts` | ✅ VNRecognizeText |
| 错误处理 | `src/util/errors.ts` | ✅ 类型化错误 |
| 重试机制 | `src/util/retry.ts` | ✅ 指数退避 |
| 日志 | `src/util/logger.ts` | ✅ 结构化日志 |
| 单元测试 | `tests/unit/` | ✅ 44 通过 |
| E2E 测试 | `tests/integration/` | ✅ 12/12 通过 |

### 待实现模块

| 模块 | 文件 | 优先级 | 复杂度 |
|------|------|--------|--------|
| MCP Instructions | `src/mcp/instructions.ts` | P1 | 低 |
| doctor 命令 | `src/bin/doctor.ts` | P1 | 低 |
| 注入检测 | `src/safety/injection.ts` | P1 | 中 |
| set_value 工具 | 扩展 `src/platform/macos.ts` | P2 | 中 |
| wait 工具 | `src/mcp/tools.ts` | P2 | 低 |
| Windows 适配 | `src/platform/windows.ts` | P3 | 高 |
| Linux 适配 | `src/platform/linux.ts` | P3 | 高 |
```

- [ ] **Step 2: 验证**

```bash
grep -c "砍掉" "/Users/kaguya/Documents/Obsidian Vault/Projects/Universal-Computer-Use-MCP/工程计划.md"
```

Expected: 看到砍掉模块的描述

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "docs: 工程计划 v2.1 — 模块清单修订，砍掉低ROI模块"
```

---

### Task 4: 重写开发阶段与技术方案

**Files:**
- Rewrite: `/Users/kaguya/Documents/Obsidian Vault/Projects/Universal-Computer-Use-MCP/工程计划.md:290-end`

- [ ] **Step 1: 替换 §四 开发阶段和 §五 技术方案**

将 §四-七 替换为：

```markdown
## 四、开发阶段（v2.1 修订）

### Phase 0: 架构重构 ✅ 已完成

> 修复 ESM 兼容性，重构模块架构

- [x] 0.1 修复 macOS require() → ESM import 兼容性 ✅
- [x] 0.2 TypeScript 编译通过 ✅
- [x] 0.3 SafetyGuard key blocklist 修复 ✅ (2026-05-30)
- [x] 0.4 CGEvent modifier flags 修复 ✅ (2026-05-30)
- [x] 0.5 typeText CGEvent 后台注入 ✅ (2026-05-30)
- [x] 0.6 JXA 注入漏洞修复 ✅ (2026-05-30)
- [x] 0.7 死代码清理 ✅ (2026-05-30)

### Phase 1: 核心增强（3 天）

> MCP Instructions + doctor 命令 + 注入检测

- [ ] 1.1 MCP Instructions: server.ts initialize 响应中加 instructions 字段
- [ ] 1.2 doctor 命令: 检查 Accessibility 权限 + Screen Recording 权限 + Node.js 版本
- [ ] 1.3 注入检测: type_text 入口添加 shell/JXA 注入正则检测
- [ ] 1.4 set_value 工具: AXUIElementSetValue（下拉框/滑块/复选框）
- [ ] 1.5 wait 工具: sleep + wait_for_element
- [ ] 1.6 集成测试更新

### Phase 2: 质量保障（2 天）

> 测试 + 文档 + 发布准备

- [ ] 2.1 NoopBackend 测试替身（CI 无需 GUI）
- [ ] 2.2 单元测试: 注入检测
- [ ] 2.3 单元测试: doctor 命令
- [ ] 2.4 错误处理: 重试 + 优雅降级
- [ ] 2.5 使用文档 + README 更新
- [ ] 2.6 npm 发布

### Phase 3: 跨平台（未来）

> Windows/Linux 实现（按需）

- [ ] 3.1 Windows: SendInput + UIAutomation
- [ ] 3.2 Linux: xdotool + AT-SPI
- [ ] 3.3 跨平台测试

---

## 五、v2.1 vs v2.0 关键差异

| 维度 | v2.0 | v2.1 | 理由 |
|------|------|------|------|
| 工具数量 | 5 个（判别器合一） | 16 个（保持独立） | LLM 发现性更好，业界实践 |
| SOM 覆盖层 | Canvas 绘制编号 | 砍掉，用 JSON 元素列表 | JXA Canvas 复杂度高，收益低 |
| CoordinateMapper | 独立模块 | 辅助函数 | 只需 Math.round |
| AppScope | postToPid native addon | activate + clipToBounds | 避免 C++ 编译依赖 |
| capture_after | 每个工具支持 | 砍掉 | 不能减少实际往返 |
| virtual cursor overlay | P2 实现 | 砍掉 | LLM 不需要看到光标 |
| 安全机制 | 硬拦截 + 审批门控 + 上下文感知 | 硬拦截 + 注入检测 + 速率限制 | MCP 无法弹审批 UI |
| doctor 命令 | Phase 3 | Phase 1 | 权限是用户第一个障碍 |
| MCP Instructions | P1 | P1 | 保持 |

---

## 六、参考资料

1. [Hermes cua-driver 架构分析](../Hermes%20cua-driver%20架构.md)
2. [open-codex-computer-use 架构分析](../open-codex-computer-use%20分析.md)
3. [MCP Specification](https://spec.modelcontextprotocol.io/)
4. [Apple Accessibility API](https://developer.apple.com/documentation/accessibility)
5. [CGEvent Reference](https://developer.apple.com/documentation/coregraphics/cgevent)
```

- [ ] **Step 2: 验证文件完整**

```bash
wc -l "/Users/kaguya/Documents/Obsidian Vault/Projects/Universal-Computer-Use-MCP/工程计划.md"
```

Expected: 文件行数合理（约 250-350 行）

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "docs: 工程计划 v2.1 — 开发阶段和技术方案修订完成"
```

---

### Task 5: 同步更新 Obsidian 进度跟踪

**Files:**
- Update: `/Users/kaguya/Documents/Obsidian Vault/Projects/Universal-Computer-Use-MCP/进度跟踪.md`
- Update: `/Users/kaguya/Documents/Obsidian Vault/UCU-MCP项目/进度追踪.md`

- [ ] **Step 1: 更新进度跟踪.md 的 Phase 0 状态**

将进度跟踪.md 中的 Phase 0 进度表更新为：

```markdown
## Phase 0 进度：架构重构 ✅ 已完成

| 任务 | 状态 | 备注 |
|------|------|------|
| 0.1 修复 ESM 兼容性 | ✅ 完成 | 已使用 ESM import |
| 0.2 重构 9→5 工具 Schema | ❌ 取消 | v2.1 决定保持 16 个独立工具 |
| 0.3 AccessibilityEngine 骨架 | ✅ 已有 | get_window_state + find_element 已实现 |
| 0.4 CoordinateMapper 骨架 | ❌ 取消 | v2.1 简化为辅助函数 |
| 0.5 AppScope 骨架 | ❌ 取消 | v2.1 简化为 activate + clipToBounds |
| 0.6 SafetyGuard 三层重构 | ✅ 部分完成 | 硬拦截+速率限制已实现，注入检测待做 |
| 0.7 TypeScript 编译通过 | ✅ 完成 | tsc --noEmit 无错误 |
| 0.8 SafetyGuard key blocklist 修复 | ✅ 完成 | 2026-05-30 |
| 0.9 CGEvent modifier flags 修复 | ✅ 完成 | 2026-05-30 |
| 0.10 typeText CGEvent 后台注入 | ✅ 完成 | 2026-05-30 |
| 0.11 JXA 注入漏洞修复 | ✅ 完成 | 2026-05-30 |
| 0.12 死代码清理 | ✅ 完成 | dispatcher + 9 tool handlers 已删除 |
```

- [ ] **Step 2: 更新进度跟踪.md 的 Phase 1 待办**

```markdown
## Phase 1 待办：核心增强（v2.1）

- [ ] 1.1 MCP Instructions（initialize 时返回使用指导）
- [ ] 1.2 doctor 命令（权限 + 依赖检查）
- [ ] 1.3 注入检测（type_text 内容扫描）
- [ ] 1.4 set_value 工具（AXUIElementSetValue）
- [ ] 1.5 wait 工具
- [ ] 1.6 集成测试更新
```

- [ ] **Step 3: 更新进度追踪.md 的工程计划版本引用**

在进度追踪.md 的安全审计部分之后添加：

```markdown
## 工程计划 v2.1 修订 — 2026-05-30

### 主要变更
- 工具 Schema: 5 个 → 保持 16 个独立工具
- 砍掉: virtual cursor overlay、capture_after、CoordinateMapper 独立模块
- 简化: SOM 覆盖层 → JSON 元素列表；AppScope → activate + clipToBounds
- 修正: 安全机制三层改为 硬拦截+注入检测+速率限制
- 新增: doctor 命令提前到 Phase 1

### 详细修订见
→ `Projects/Universal-Computer-Use-MCP/工程计划.md` (v2.1)
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: 同步更新 Obsidian 进度跟踪，反映 v2.1 修订"
```

---

### Task 6: 自检 — 验证所有文件一致性

**Files:**
- Read: 所有修改的 Obsidian 文件

- [ ] **Step 1: 验证工程计划.md 版本号一致**

```bash
grep -c "v2.1" "/Users/kaguya/Documents/Obsidian Vault/Projects/Universal-Computer-Use-MCP/工程计划.md"
```

Expected: 多处出现 v2.1

- [ ] **Step 2: 验证进度跟踪.md Phase 0 全部标记完成**

```bash
grep "⬜" "/Users/kaguya/Documents/Obsidian Vault/Projects/Universal-Computer-Use-MCP/进度跟踪.md"
```

Expected: 无输出（没有待开始的任务）

- [ ] **Step 3: 验证备份文件存在**

```bash
ls -la "/Users/kaguya/Documents/Obsidian Vault/Projects/Universal-Computer-Use-MCP/工程计划-v2-backup.md"
```

Expected: 文件存在

- [ ] **Step 4: 最终 Commit**

```bash
git add -A && git commit -m "docs: 工程计划 v2.1 修订完成，全部 Obsidian 文件同步"
```
