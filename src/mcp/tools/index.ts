/**
 * Tool registry for UCU-MCP.
 *
 * Registers 24 MCP tools on the server and dispatches each call through
 * a shared safety/permission/retry pipeline (`withSafety`).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createLogger } from "../../util/logger.js";
import { mcpErrorResponse, startUserActivityMonitor, stopUserActivityMonitor } from "./helpers.js";
import { registerScreenTools } from "./screen-tools.js";
import { registerInputTools } from "./input-tools.js";
import { registerKeyboardTools } from "./keyboard-tools.js";
import { registerElementTools, findElementInputSchema } from "./element-tools.js";
import { registerAppTools } from "./app-tools.js";

export { getActiveTarget, __setPlatformForTesting } from "./helpers.js";
export { startUserActivityMonitor, stopUserActivityMonitor } from "./helpers.js";
export { findElementInputSchema } from "./element-tools.js";

const log = createLogger("tools");

export class ToolRegistry {
  private static _instance: ToolRegistry | undefined;
  readonly tools: string[] = [];
  private readonly _handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  static get instance(): ToolRegistry { if (!ToolRegistry._instance) ToolRegistry._instance = new ToolRegistry(); return ToolRegistry._instance; }
  register(name: string, handler?: (args: Record<string, unknown>) => Promise<unknown>): void {
    this.tools.push(name);
    if (handler) this._handlers.set(name, handler);
  }
  async dispatch(name: string, args: Record<string, unknown>): Promise<any> {
    const handler = this._handlers.get(name);
    if (!handler) return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    return handler(args);
  }
}

export function registerTools(server: McpServer): void {
  const registry = ToolRegistry.instance;
  const registerTool = (
    name: string,
    description: string,
    schema: Record<string, any>,
    handler: (params: any) => Promise<any>,
  ) => {
    registry.register(name);
    server.tool(name, description, schema, async (params: any) => {
      try {
        return await handler(params);
      } catch (error) {
        return mcpErrorResponse(error);
      }
    });
  };

  registerScreenTools(registerTool);
  registerInputTools(registerTool);
  registerKeyboardTools(registerTool);
  registerElementTools(registerTool);
  registerAppTools(registerTool);

  log.info("Registered tools", { count: registry.tools.length, tools: registry.tools.join(", ") });
}
