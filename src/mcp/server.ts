import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStdioTransport } from "./transport.js";
import { registerTools, startUserActivityMonitor } from "./tools/index.js";

const UCU_MCP_INSTRUCTIONS = `
UCU-MCP is a cross-client computer-use server for Claude Code CLI/Desktop, OpenCode, and other MCP clients.

Pick the right tool sequence for the task:

• Fill a form field → find_element (text/role) + type_in_element or set_value. Prefer AX over coordinates.
• Click a menu bar item → get_screen_size + click with coordinates (menu bar is not in the AX tree).
• Read what's on screen → screenshot; for text not in AX use ocr; for a structured tree use get_window_state.
• Switch between apps → list_apps, then focus_app; subsequent tools use the active target context.
• Verify an action succeeded → captureAfter=true on action tools, or call screenshot afterwards.
• Wait for UI to change → wait_for_element (until: "appear" default; also "disappear" or "value_change").
• Recover from TARGET_STALE → call focus_app again for the target app, then retry the action.
• Read or write the clipboard → clipboard_read / clipboard_write.

General rules: on macOS call list_apps/focus_app first to establish target context, then prefer AX tools (find_element → click_element / type_in_element / set_value). Use coordinates only when AX lookup is unavailable. Actions are blocked while macOS is locked; dangerous shortcuts and sensitive windows are blocked; suspicious injected text is rejected. type_in_element can refetch equivalent AX elements when the UI tree changes. Run doctor to check Accessibility and Screen Recording permissions. Windows and Linux adapters are explicit stubs until their native backends are implemented.
`.trim();

function getPackageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const path = join(dir, "package.json");
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as { version?: string };
      return parsed.version ?? "0.0.0";
    }
    dir = dirname(dir);
  }
  return "0.0.0";
}

export async function startServer(): Promise<void> {
  const server = new McpServer({
    name: "ucu-mcp",
    version: getPackageVersion(),
  }, {
    instructions: UCU_MCP_INSTRUCTIONS,
  });

  registerTools(server);
  startUserActivityMonitor();

  const transport = createStdioTransport();
  await server.connect(transport);

  console.error("ucu-mcp server started on stdio");
}
