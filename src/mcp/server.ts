import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStdioTransport } from "./transport.js";
import { registerTools, startUserActivityMonitor } from "./tools.js";

const UCU_MCP_INSTRUCTIONS = `
UCU-MCP is a cross-client computer-use server for Claude Code CLI, Claude Code Desktop, OpenCode, and other MCP clients.

Use screenshots and window state to observe before acting. On macOS, prefer list_apps/focus_app to establish the target app context, then use AX element tools when an element can be identified: find_element, then click_element, set_value, or type_in_element. Fall back to coordinates only when AX lookup is unavailable or ambiguous.

Before repeated UI work, call get_screen_size and list_windows so coordinates and target windows are explicit. Use get_window_state for structured UI trees. Use ocr when visible text is not exposed through Accessibility. For tight observe-act loops, set captureAfter=true on action tools to receive a post-action screenshot in the same tool response.

Safety model: actions are blocked while macOS is locked, dangerous shortcuts and sensitive windows are blocked, and suspicious injected text is rejected. For text entry into UI controls, prefer type_in_element because it can refetch equivalent AX elements if the UI tree changes.

For Claude Code CLI/Desktop and OpenCode configs, run the ucu-mcp executable over stdio. If tools fail on macOS, run doctor first to check Accessibility and Screen Recording permissions. Windows and Linux adapters are explicit stubs until their native backends are implemented.
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
