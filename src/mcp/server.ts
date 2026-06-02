import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createStdioTransport } from "./transport.js";
import { registerTools } from "./tools.js";

const UCU_MCP_INSTRUCTIONS = `
UCU-MCP is a cross-client computer-use server for Claude Code CLI, Claude Code Desktop, OpenCode, and other MCP clients.

Use screenshots and window state to observe before acting. On macOS, prefer list_apps/focus_app to establish the target app context, then use AX element tools when an element can be identified: find_element, then click_element, set_value, or type_in_element. Fall back to coordinates only when AX lookup is unavailable or ambiguous.

Before repeated UI work, call get_screen_size and list_windows so coordinates and target windows are explicit. Use get_window_state for structured UI trees. Use ocr when visible text is not exposed through Accessibility. For tight observe-act loops, set captureAfter=true on action tools to receive a post-action screenshot in the same tool response.

Safety model: actions are blocked while macOS is locked, dangerous shortcuts and sensitive windows are blocked, and suspicious injected text is rejected. For text entry into UI controls, prefer type_in_element because it can refetch equivalent AX elements if the UI tree changes.

For Claude Code CLI/Desktop and OpenCode configs, run the ucu-mcp executable over stdio. If tools fail on macOS, run doctor first to check Accessibility and Screen Recording permissions. Windows and Linux adapters are explicit stubs until their native backends are implemented.
`.trim();

export async function startServer(): Promise<void> {
  const server = new McpServer({
    name: "ucu-mcp",
    version: "0.1.0",
  }, {
    instructions: UCU_MCP_INSTRUCTIONS,
  });

  registerTools(server);

  const transport = createStdioTransport();
  await server.connect(transport);

  console.error("ucu-mcp server started on stdio");
}
