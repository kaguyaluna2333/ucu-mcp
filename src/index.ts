import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export { startServer } from "./mcp/server.js";
export { ToolRegistry } from "./mcp/tools/index.js";
export { Platform } from "./platform/base.js";
export { SafetyGuard } from "./safety/guard.js";
export {
  checkPermissions,
  checkPermission,
  type PermissionCheckResult,
  type PermissionType,
} from "./safety/permissions.js";
export { MacOSPlatform } from "./platform/macos/index.js";

/**
 * Create a stdio transport for the MCP server.
 *
 * @deprecated Construct `new StdioServerTransport()` directly. Retained as a
 *   backward-compatible public API shim; the internal server no longer routes
 *   through this wrapper.
 */
export function createStdioTransport(): StdioServerTransport {
  return new StdioServerTransport();
}
