/**
 * Tool Registry and Dispatcher for UCU-MCP.
 *
 * Each tool passes through SafetyGuard before reaching the PlatformAdapter.
 * Tool registrations are split into per-tool files under ./tools/ for maintainability.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerScreenshot,
  registerListWindows,
  registerListApps,
  registerFocusApp,
  registerGetWindowState,
  registerClick,
  registerDoubleClick,
  registerTypeText,
  registerPressKey,
  registerScroll,
  registerDrag,
  registerDoctor,
  registerWait,
  registerWaitForElement,
  registerGetCursorPosition,
  registerGetScreenSize,
  registerOcr,
  registerMove,
  registerFindElement,
  registerClickElement,
  registerSetValue,
  registerTypeInElement,
} from "./tools/index.js";

// Re-export for consumers that import from this module
export { ToolResult } from "./tools/core.js";

export function registerTools(server: McpServer): void {
  registerScreenshot(server);
  registerListWindows(server);
  registerListApps(server);
  registerFocusApp(server);
  registerGetWindowState(server);
  registerClick(server);
  registerDoubleClick(server);
  registerTypeText(server);
  registerPressKey(server);
  registerScroll(server);
  registerDrag(server);
  registerDoctor(server);
  registerWait(server);
  registerWaitForElement(server);
  registerGetCursorPosition(server);
  registerGetScreenSize(server);
  registerOcr(server);
  registerMove(server);
  registerFindElement(server);
  registerClickElement(server);
  registerSetValue(server);
  registerTypeInElement(server);
}
