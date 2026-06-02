#!/usr/bin/env node

import { startServer } from "../src/mcp/server.js";
import { checkPermissions } from "../src/safety/permissions.js";
import { MacOSPlatform } from "../src/platform/macos.js";

async function runDoctor(): Promise<void> {
  const permissions = await checkPermissions();
  const screenLocked = process.platform === "darwin"
    ? new MacOSPlatform().isScreenLocked?.() ?? false
    : false;
  const report = {
    ok: permissions.granted && !screenLocked,
    platform: process.platform,
    node: process.version,
    permissions,
    screenLocked,
    safety: {
      urlBlocklist: true,
      lockScreenGuard: process.platform === "darwin",
      typedTextInjectionScan: true,
    },
    stdioCommand: "ucu-mcp",
    clients: {
      claudeCodeCli: "Run ucu-mcp as an MCP stdio server.",
      claudeCodeDesktop: "Configure ucu-mcp as a local MCP stdio server and grant permissions to the desktop app.",
      openCode: "Configure ucu-mcp as a local MCP stdio server.",
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "doctor") {
    await runDoctor();
    return;
  }
  if (command === "--help" || command === "-h") {
    console.log("Usage: ucu-mcp [doctor]\n\nWithout arguments, starts the MCP stdio server.");
    return;
  }
  await startServer();
}

main().catch((err) => {
  console.error("Fatal error starting ucu-mcp:", err);
  process.exit(1);
});
