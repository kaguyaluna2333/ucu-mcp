import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const binPath = join(repoRoot, "bin", "ucu-mcp.ts");
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as { version: string };

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", binPath, ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseJsonRpcMessages(stdout: string): any[] {
  return stdout
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        // The line may be split across stdout chunk boundaries while the
        // child is still writing. waitForJsonRpcResponses will re-poll.
        return null;
      }
    })
    .filter((msg): msg is any => msg !== null);
}

async function waitForJsonRpcResponses(stdout: () => string, ids: number[], timeoutMs = 5000): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  let lastMessages: any[] = [];
  while (Date.now() < deadline) {
    lastMessages = parseJsonRpcMessages(stdout());
    if (ids.every((id) => lastMessages.some((message) => message.id === id))) {
      return lastMessages;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return lastMessages;
}

async function runMcpSmoke(): Promise<{
  instructions?: string;
  serverInfo?: { name?: string; version?: string };
  tools: string[];
  toolDefinitions: Array<{
    name: string;
    description?: string;
    inputSchema?: {
      properties?: Record<string, unknown>;
    };
  }>;
  doctor: Record<string, unknown>;
  stderr: string;
}> {
  const child = spawn(process.execPath, ["--import", "tsx", binPath], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const send = (message: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest-smoke", version: "0" },
    },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "doctor", arguments: {} } });

  const messages = await waitForJsonRpcResponses(() => stdout, [1, 2, 3]);
  child.kill();
  await once(child, "close").catch(() => {});

  const initialize = messages.find((message) => message.id === 1)?.result;
  const toolDefinitions = messages.find((message) => message.id === 2)?.result?.tools ?? [];
  const tools = toolDefinitions.map((tool: { name: string }) => tool.name);
  const doctorText = messages.find((message) => message.id === 3)?.result?.content?.[0]?.text ?? "{}";

  return {
    instructions: initialize?.instructions,
    tools,
    toolDefinitions,
    doctor: JSON.parse(doctorText),
    stderr,
    serverInfo: initialize?.serverInfo,
  };
}

async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
  env?: NodeJS.ProcessEnv,
): Promise<{ result?: any; error?: any; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", binPath], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const send = (message: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest-call", version: "0" },
    },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });

  const messages = await waitForJsonRpcResponses(() => stdout, [2]);
  child.kill();
  await once(child, "close").catch(() => {});

  const response = messages.find((message) => message.id === 2) ?? {};
  return { result: response.result, error: response.error, stderr };
}

describe("CLI and MCP compatibility", () => {
  it("prints CLI help without starting stdio mode", async () => {
    const result = await runCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: ucu-mcp [doctor]");
    expect(result.stdout).toContain("starts the MCP stdio server");
  });

  it("prints doctor readiness JSON for local clients", async () => {
    const result = await runCli(["doctor"]);
    expect([0, 1]).toContain(result.code);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      platform: process.platform,
      stdioCommand: "ucu-mcp",
      safety: {
        urlBlocklist: true,
        typedTextInjectionScan: true,
      },
    });
    expect(report.clients).toHaveProperty("claudeCodeCli");
    expect(report.clients).toHaveProperty("claudeCodeDesktop");
    expect(report.clients).toHaveProperty("openCode");
  });

  it("exposes instructions and Mac completion tools over MCP stdio", async () => {
    const result = await runMcpSmoke();
    expect(result.instructions).toContain("Claude Code CLI/Desktop");
    expect(result.serverInfo).toMatchObject({
      name: "ucu-mcp",
      version: packageJson.version,
    });
    expect(result.tools).toEqual(expect.arrayContaining([
      "doctor",
      "wait",
      "wait_for_element",
      "list_apps",
      "focus_app",
      "set_value",
    ]));
    expect(result.tools.length).toBe(26);
    expect(result.doctor.safety).toMatchObject({
      urlBlocklist: true,
      lockScreenGuard: process.platform === "darwin",
      typedTextInjectionScan: true,
    });
  });

  it("documents screenshot encode options in the MCP schema", async () => {
    const result = await runMcpSmoke();
    const screenshot = result.toolDefinitions.find((tool) => tool.name === "screenshot");

    expect(screenshot?.inputSchema?.properties).toMatchObject({
      maxWidth: {
        type: "number",
        default: 1280,
        description: "Maximum output width in pixels. Aspect ratio is preserved.",
      },
      format: {
        type: "string",
        enum: ["png", "jpeg"],
        default: "png",
        description: "Image format",
      },
      windowId: {
        type: "string",
      },
    });
  });

  it("documents captureAfter options on action tools", async () => {
    const result = await runMcpSmoke();
    for (const toolName of ["click", "scroll", "drag", "move", "type_text", "press_key", "click_element", "set_value", "type_in_element"]) {
      const tool = result.toolDefinitions.find((definition) => definition.name === toolName);
      expect(tool?.inputSchema?.properties).toMatchObject({
        captureAfter: {
          type: "boolean",
          default: false,
        },
        captureMaxWidth: {
          type: "number",
          default: 1280,
        },
        captureFormat: {
          type: "string",
          enum: ["png", "jpeg"],
          default: "jpeg",
        },
      });
    }
  });

  it("documents ergonomic aliases for common client parameter names", async () => {
    const result = await runMcpSmoke();
    const pressKey = result.toolDefinitions.find((tool) => tool.name === "press_key");
    const scroll = result.toolDefinitions.find((tool) => tool.name === "scroll");
    const waitForElement = result.toolDefinitions.find((tool) => tool.name === "wait_for_element");

    expect(pressKey?.inputSchema?.properties).toMatchObject({
      key: { type: "string" },
      modifiers: {
        type: "array",
        items: { type: "string" },
      },
    });
    expect(scroll?.inputSchema?.properties).toMatchObject({
      deltaX: {
        type: "number",
        default: 0,
      },
    });
    expect(waitForElement?.inputSchema?.properties).toMatchObject({
      timeoutMs: { type: "number" },
      intervalMs: { type: "number" },
    });
  });

  it("documents find_element performance controls in the MCP schema", async () => {
    const result = await runMcpSmoke();
    const findElement = result.toolDefinitions.find((tool) => tool.name === "find_element");

    expect(findElement?.inputSchema?.properties).toMatchObject({
      includeBounds: {
        type: "boolean",
        default: true,
      },
      maxResults: {
        type: "number",
        default: 50,
        minimum: 1,
        maximum: 200,
      },
    });
  });

  it("rejects unsupported keyboard windowId targeting even in dry-run", async () => {
    const result = await callMcpTool(
      "type_text",
      { text: "hello", windowId: "win-1" },
      { UCU_DRY_RUN: "true" },
    );

    expect(result.result?.isError).toBe(true);
    const error = JSON.parse(result.result?.content?.[0]?.text).error;
    expect(error).toMatchObject({
      code: "UNSUPPORTED_PARAMETER",
      retryable: false,
      message: "windowId-targeted keyboard typing is not implemented",
    });
    expect(error.recovery).toContain("unsupported parameter");
    expect(result.result?.content?.[0]?.text).not.toContain("[DRY RUN]");
  });

  it("rejects unsupported press_key windowId targeting before execution", async () => {
    const result = await callMcpTool(
      "press_key",
      { key: "enter", windowId: "win-1" },
      { UCU_DRY_RUN: "true" },
    );

    expect(result.result?.isError).toBe(true);
    const error = JSON.parse(result.result?.content?.[0]?.text).error;
    expect(error).toMatchObject({
      code: "UNSUPPORTED_PARAMETER",
      retryable: false,
      message: "windowId-targeted key events are not implemented",
    });
    expect(error.recovery).toContain("unsupported parameter");
    expect(result.result?.content?.[0]?.text).not.toContain("[DRY RUN]");
  });
});
