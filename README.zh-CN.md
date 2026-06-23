# ucu-mcp

[English](README.md) | [简体中文](README.zh-CN.md)

Universal Computer Use MCP —— 为任意 AI agent 提供桌面自动化的 MCP 服务器。

## 概览

UCU-MCP（Universal Computer Use MCP）是一个 Model Context Protocol 服务器，赋予 AI agent 在 macOS 上的桌面自动化能力。它在系统允许处优先采用非侵入式观察与输入：坐标鼠标事件保留物理光标，`set_value` 直接写 AX 值，聚焦键盘输入显式进行。

## 特性

- **通用**：兼容 Claude Code、OpenCode、Codex、Gemini CLI 及任意 MCP 客户端
- **macOS 原生**：今天是完整的 macOS 实现（辅助功能、ScreenCaptureKit、SkyLight）。Windows/Linux 在路线图上——其适配器在原生后端落地前显式失败
- **非侵入（尽可能）**：坐标鼠标事件保留光标位置；`set_value` 避免聚焦 AX 元素；需要当前焦点的工具会明确说明
- **受 Codex 启发**：AX 元素重取、MCP 指令、锁屏守护、URL 黑名单、运行时 doctor 检查
- **安全**：内置权限检查与危险动作拦截
- **可扩展**：模块化架构，易于新增平台与工具

## 安装

### 全局安装（推荐）

```bash
npm install -g ucu-mcp
```

然后运行：

```bash
ucu-mcp
```

### npx 一次性运行（无需安装）

```bash
npx -y ucu-mcp
```

## Claude Desktop 集成

1. 将下方配置复制到 Claude Desktop 配置文件：
   - **macOS**：`~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows**：`%APPDATA%\Claude\claude_desktop_config.json`

2. 在 `mcpServers` 对象中加入：

```json
{
  "mcpServers": {
    "ucu-mcp": {
      "command": "npx",
      "args": ["-y", "ucu-mcp"]
    }
  }
}
```

3. 重启 Claude Desktop，UCU-MCP 工具会自动出现。

## 工具列表（26 个，五大类）

完整参数与用法见 [英文 README · Tool List](README.md#tool-list)。

### 屏幕与窗口
`screenshot`（截屏，支持 `describe=true` 附结构化文字描述） · `describe_screen`（视觉降级时的结构化文字回退） · `list_windows` · `list_apps` · `focus_app`（建立会话目标） · `get_window_state`（窗口 AX 树） · `get_screen_size` · `ocr`

### 鼠标与输入
`click` · `double_click` · `scroll` · `drag` · `move`（侵入，移动光标） · `get_cursor_position`

### 键盘
`type_text` · `press_key`（单键如 Enter/Escape，或组合快捷键）

### AX 元素交互
`find_element` · `click_element` · `set_value` · `type_in_element` · `click_menu_bar_extra`（托盘/菜单栏图标）

### 运行时与同步
`doctor` · `wait` · `wait_for_element` · `clipboard_read` · `clipboard_write`

> 动作工具支持 `captureAfter`：动作成功后在同一响应中附上动作后截图，省去一次 `screenshot` 往返。

## macOS 权限设置

UCU-MCP 在 macOS 需要两项系统权限：

### 1. 辅助功能（Accessibility）—— click/type/key/drag/scroll/move 必需

1. 打开 **系统设置** > **隐私与安全性** > **辅助功能**
2. 点 **+**，添加你的终端 app（如 Terminal、iTerm2，或运行 `ucu-mcp` 的 app）
3. 确保开关已**开启**

### 2. 屏幕录制（Screen Recording）—— screenshot/ocr/list_windows/get_screen_size 必需

1. 打开 **系统设置** > **隐私与安全性** > **屏幕录制**
2. 点 **+**，添加终端 app
3. 确保开关已**开启**

### 验证权限

```bash
ucu-mcp doctor
```

## 安全

### 内置安全规则

1. **按键黑名单**：拦截危险快捷键（macOS：`Cmd+Q`/`Cmd+W`/`Cmd+L`/`Cmd+Option+Esc` 等；Windows/Linux：`Alt+F4`/`Ctrl+Alt+Del` 等）
2. **窗口跳过表**：敏感窗口跳过（1Password、Bitwarden、KeePass、Keychain Access，以及标题含 "bank"/"paypal" 的窗口）
3. **速率限制**：动作间至少 100ms（防失控循环）

### 环境变量配置

```bash
export UCU_RATE_LIMIT_MS=100      # 最小动作间隔（ms）
export UCU_LOG_LEVEL=info          # debug / info / warn / error
export UCU_DRY_RUN=1               # 干运行模式（不执行真实动作）
```

自定义安全规则可通过 `UCU_SAFETY_CONFIG` 指向 `safety.json`，详见 [英文 README · Safety](README.md#safety)。

## MCP 客户端配置

UCU-MCP 作为 stdio MCP 服务器运行。Claude Code CLI/Desktop、Codex CLI、OpenCode 的具体配置示例见 [英文 README · Configuration for MCP Clients](README.md#configuration-for-mcp-clients)。

## Agent Skill

UCU-MCP 附带一个可安装的 **agent skill**（为 Claude Code、Codex、OpenCode 等 CLI agent 编写），提供比内嵌 MCP `instructions:` 更丰富的指引：决策循环（观察 → 决策 → 行动 → 验证）、工具选择规则（AX 优先 / 视觉回退 / 托盘）、点击结果信号解读（`method`/`verified`）、任务 playbook 与错误恢复参考。

```bash
# Codex
npx skills add ucu-mcp -g -a codex --skill ucu-mcp -y
# Claude Code
npx skills add ucu-mcp -g -a claude-code --skill ucu-mcp -y
```

## 致谢 / 灵感来源

UCU-MCP 站在多个项目与理念的肩膀上：

- **[OpenAI Codex Computer Use](https://openai.com/codex)** —— ScreenCaptureKit 单窗口捕获技术（读取窗口合成表面以无视遮挡）与 AX↔视觉 render-tree 映射理念，均源自 Codex 的 `SkyComputerUseService`。UCU-MCP 的 `native/sck` helper 与 native-first AX 遍历（`native/ax`）追求相同目标。
- **[trycua/cua](https://github.com/trycua/cua)** —— SkyLight per-process 输入方案（`SLEventPostToPid` / `focusWithoutRaise`），让 agent 在不抢焦点、不动光标的前提下点击/输入后台窗口。UCU-MCP 的 `native/skylight` helper 实现相同 SPI。
- **[Model Context Protocol](https://modelcontextprotocol.io)**（Anthropic）—— 本服务器所讲的开放标准。
- **Apple 框架** —— ApplicationServices（辅助功能）、ScreenCaptureKit、CoreGraphics，以及 SkyLight 私有 SPI。

native-AX 提速工作（用 CoreFoundation `AXUIElementCopyAttributeValue` 取代 JXA / `osascript` bridge，约 200 倍提速）的动机来自 Codex 的响应速度目标。

## 架构

```
src/
├── mcp/                    # MCP 协议层（server / tools / transport）
├── platform/               # 平台抽象（base + macos 实现）
│   └── macos/              # AX / SCK / SkyLight 调用
├── utils/                  # 截图、输入合成
└── util/                   # 错误、日志
native/                     # Swift 原生 helper
├── ax/                     # CoreFoundation AX 遍历（find_element / get_window_state）
├── sck/                    # ScreenCaptureKit 单窗口捕获（无视遮挡）
├── skylight/               # per-pid 后台输入（不抢前台）
├── windowlist/ ocr/ cgevent/
```

## 开发

```bash
git clone https://github.com/kaguya/ucu-mcp.git
cd ucu-mcp
npm install
npm run build
npm test
```

macOS GUI 冒烟测试（会打开并编辑临时 TextEdit 文档）需显式开启：

```bash
npm run test:macos-gui
```

## 许可证

MIT
