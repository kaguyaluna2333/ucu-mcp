import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runClientSmoke = process.env.UCU_CLIENT_CLI_SMOKE === "1";
const describeClientSmoke = runClientSmoke ? describe : describe.skip;
const repoRoot = process.cwd();
const distBin = join(repoRoot, "dist", "bin", "ucu-mcp.js");

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf-8",
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * v2 helpers — drive the actual stdio server (npx ucu-mcp@latest, or local
 * when UCU_CLIENT_CLI_USE_LOCAL=1) through a JSON-RPC handshake.
 */

type JsonRpcMessage = { id?: number; method?: string; result?: any; error?: any };

interface SpawnedMcp {
  command: string;
  args: string[];
  child: ReturnType<typeof spawn>;
  stdout: () => string;
  stderr: () => string;
  send: (message: Record<string, unknown>) => void;
  kill: () => Promise<void>;
}

function resolveMcpCommand(): { command: string; args: string[]; label: string } {
  if (process.env.UCU_CLIENT_CLI_USE_LOCAL === "1") {
    return {
      command: "node",
      args: [distBin],
      label: `local ${distBin}`,
    };
  }
  return {
    command: "npx",
    args: ["-y", "--", "ucu-mcp@latest"],
    label: "npx -y -- ucu-mcp@latest",
  };
}

function spawnMcpServer(timeoutMs = 60_000): Promise<SpawnedMcp> {
  const { command, args } = resolveMcpCommand();
  const home = join(mkdtempSync(join(tmpdir(), "ucu-mcp-v2-")), "home");
  mkdirSync(home, { recursive: true });

  const child = spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, NO_UPDATE_NOTIFIER: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  // Best-effort watchdog so a hung npx install doesn't pin the test run.
  const watchdog = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }, timeoutMs);

  return Promise.resolve({
    command,
    args,
    child,
    stdout: () => Buffer.concat(stdoutChunks).toString("utf-8"),
    stderr: () => Buffer.concat(stderrChunks).toString("utf-8"),
    send: (message) => {
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    },
    kill: async () => {
      clearTimeout(watchdog);
      if (!child.killed) {
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
      }
      await once(child, "close").catch(() => {});
    },
  });
}

function parseJsonRpcLines(stdout: string): JsonRpcMessage[] {
  return stdout
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRpcMessage);
}

async function waitForResponses(
  mcp: SpawnedMcp,
  ids: number[],
  timeoutMs = 15_000,
): Promise<{ messages: JsonRpcMessage[]; timedOut: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let last: JsonRpcMessage[] = [];
  while (Date.now() < deadline) {
    try {
      last = parseJsonRpcLines(mcp.stdout());
    } catch {
      last = [];
    }
    if (ids.every((id) => last.some((message) => message.id === id))) {
      return { messages: last, timedOut: false };
    }
    if (mcp.child.exitCode !== null) {
      return { messages: last, timedOut: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { messages: last, timedOut: true };
}

function tailForReport(text: string, maxChars = 500): string {
  if (text.length <= maxChars) return text;
  return `…${text.slice(-maxChars)}`;
}

interface FailureReport {
  command: string;
  args: string[];
  status: string;
  stderrTail: string;
  suggestion: string;
}

function buildFailureReport(
  mcp: SpawnedMcp,
  status: string,
  extraStderr = "",
): FailureReport {
  const stderr = `${mcp.stderr()}${extraStderr}`;
  const lower = stderr.toLowerCase();
  let suggestion =
    "Verify network access, ensure the ucu-mcp package is published on npm, and rerun the smoke.";
  if (process.env.UCU_CLIENT_CLI_USE_LOCAL === "1") {
    suggestion = `Build the project first (npm run build) so ${distBin} exists, then rerun with UCU_CLIENT_CLI_USE_LOCAL=1.`;
  } else if (lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("network")) {
    suggestion = "Check internet access; the smoke could not reach the npm registry. Retry once online.";
  } else if (lower.includes("404") || lower.includes("not found")) {
    suggestion = "Ensure ucu-mcp@latest is published on npm. If testing a prerelease, set UCU_CLIENT_CLI_USE_LOCAL=1.";
  } else if (lower.includes("timed out") || lower.includes("timeout")) {
    suggestion = "The server took too long to respond. Rerun with UCU_CLIENT_CLI_USE_LOCAL=1 for a faster local check.";
  } else if (lower.includes("permission")) {
    suggestion = "macOS permissions may be missing. Run doctor via the CLI and grant Accessibility / Screen Recording.";
  }
  return {
    command: mcp.command,
    args: mcp.args,
    status,
    stderrTail: tailForReport(stderr),
    suggestion,
  };
}

function formatFailureReport(label: string, report: FailureReport): string {
  const cmdline = [report.command, ...report.args].join(" ");
  return [
    `[client-cli-smoke v2] ${label} failed.`,
    `  command   : ${cmdline}`,
    `  status    : ${report.status}`,
    `  stderr(…): ${report.stderrTail.replace(/\n/g, "\n               ")}`,
    `  next step : ${report.suggestion}`,
  ].join("\n");
}

interface McpHandshakeResult {
  mcp: SpawnedMcp;
  initializeResult: any;
  toolsList: JsonRpcMessage[];
  doctorResult: any;
  exitInfo: { code: number | null; signal: NodeJS.Signals | null };
}

async function driveMcpHandshake(): Promise<McpHandshakeResult> {
  const mcp = await spawnMcpServer();
  mcp.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "ucu-mcp-v2-smoke", version: "0" },
    },
  });
  mcp.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  mcp.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "doctor", arguments: {} } });

  const { messages } = await waitForResponses(mcp, [1, 2, 3]);
  const exitInfo: McpHandshakeResult["exitInfo"] = {
    code: mcp.child.exitCode,
    signal: mcp.child.signalCode,
  };
  // Capture doctor result text even if some IDs are missing — useful for partial diagnostics.
  const doctorMessage = messages.find((m) => m.id === 3);
  const doctorText = doctorMessage?.result?.content?.[0]?.text ?? "{}";
  let doctorResult: any = {};
  try { doctorResult = JSON.parse(doctorText); } catch { doctorResult = { raw: doctorText }; }
  return {
    mcp,
    initializeResult: messages.find((m) => m.id === 1)?.result,
    toolsList: messages.filter((m) => m.id === 2),
    doctorResult,
    exitInfo,
  };
}

describeClientSmoke("installed client CLI MCP compatibility", () => {
  it("Claude Code CLI can add and health-check ucu-mcp from a temporary user config", () => {
    const home = join(mkdtempSync(join(tmpdir(), "ucu-claude-")), "home");
    mkdirSync(home, { recursive: true });

    const add = run("claude", ["mcp", "add", "--scope", "user", "ucu", "--", "node", distBin], { HOME: home });
    expect(add.status, add.stderr || add.stdout).toBe(0);
    expect(add.stdout).toContain("Added stdio MCP server ucu");

    const list = run("claude", ["mcp", "list"], { HOME: home });
    expect(list.status, list.stderr || list.stdout).toBe(0);
    expect(list.stdout).toContain("ucu:");
    expect(list.stdout).toContain("Connected");
  });

  it("Codex CLI can add and read ucu-mcp from an isolated CODEX_HOME", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ucu-codex-"));

    const add = run("codex", ["mcp", "add", "ucu", "--", "node", distBin], { CODEX_HOME: codexHome });
    expect(add.status, add.stderr || add.stdout).toBe(0);
    expect(add.stdout).toContain("Added global MCP server");

    const list = run("codex", ["mcp", "list"], { CODEX_HOME: codexHome });
    expect(list.status, list.stderr || list.stdout).toBe(0);
    expect(list.stdout).toContain("ucu");
    expect(list.stdout).toContain("enabled");

    const get = run("codex", ["mcp", "get", "ucu", "--json"], { CODEX_HOME: codexHome });
    expect(get.status, get.stderr || get.stdout).toBe(0);
    const parsed = JSON.parse(get.stdout) as {
      transport?: { type?: string; command?: string; args?: string[] };
    };
    expect(parsed.transport).toMatchObject({
      type: "stdio",
      command: "node",
      args: [distBin],
    });
  });

  it("OpenCode CLI can see an enabled ucu-mcp server in its resolved MCP list", () => {
    const list = run("opencode", ["mcp", "list"]);
    expect(list.status, list.stderr || list.stdout).toBe(0);
    expect(list.stdout).toContain("ucu-mcp");
    expect(list.stdout).toContain("connected");
  });
});

describeClientSmoke("installed ucu-mcp stdio server (v2 deep handshake)", () => {
  it("completes a JSON-RPC initialize handshake against the published server", async () => {
    const handshake = await driveMcpHandshake();
    try {
      if (!handshake.initializeResult) {
        const report = buildFailureReport(
          handshake.mcp,
          `no initialize response (child exit=${handshake.exitInfo.code ?? "?"}, signal=${handshake.exitInfo.signal ?? "none"})`,
        );
        throw new Error(formatFailureReport("initialize handshake", report));
      }
      expect(handshake.initializeResult.serverInfo?.name).toBe("ucu-mcp");
      expect(typeof handshake.initializeResult.serverInfo?.version).toBe("string");
      expect(handshake.initializeResult.instructions).toContain("Claude Code CLI/Desktop");
    } finally {
      await handshake.mcp.kill();
    }
  });

  it("exposes exactly 22 tools via tools/list over the stdio transport", async () => {
    const handshake = await driveMcpHandshake();
    try {
      const listMessage = handshake.toolsList[0];
      if (!listMessage?.result?.tools) {
        const report = buildFailureReport(
          handshake.mcp,
          `no tools/list response (child exit=${handshake.exitInfo.code ?? "?"}, signal=${handshake.exitInfo.signal ?? "none"})`,
        );
        throw new Error(formatFailureReport("tools/list enumeration", report));
      }
      const toolNames = (listMessage.result.tools as Array<{ name: string }>).map((t) => t.name);
      expect(toolNames.length, `expected 22 tools, got ${toolNames.length}: ${toolNames.join(", ")}`).toBe(22);
      for (const required of ["doctor", "screenshot", "list_apps", "find_element", "click_element", "type_in_element"]) {
        expect(toolNames, `tools/list missing ${required}`).toContain(required);
      }
    } finally {
      await handshake.mcp.kill();
    }
  });

  it("returns readiness, safety, and clients from tools/call doctor", async () => {
    const handshake = await driveMcpHandshake();
    try {
      const hasReadiness = handshake.doctorResult?.readiness !== undefined;
      const hasOk = handshake.doctorResult?.ok !== undefined;
      if (!hasReadiness && !hasOk) {
        const report = buildFailureReport(
          handshake.mcp,
          `no doctor response (child exit=${handshake.exitInfo.code ?? "?"}, signal=${handshake.exitInfo.signal ?? "none"})`,
        );
        throw new Error(formatFailureReport("doctor invocation", report));
      }
      // `doctor` (CLI mode) uses `ok`; the MCP tool uses `readiness`. Accept either shape.
      const doctor = handshake.doctorResult;
      const readiness = doctor.readiness ?? (doctor.ok ? "ready" : "blocked");
      expect(["ready", "degraded", "blocked"]).toContain(readiness);
      expect(doctor.safety, "doctor missing safety section").toMatchObject({
        urlBlocklist: true,
        typedTextInjectionScan: true,
      });
      expect(doctor.clients, "doctor missing clients section").toBeTypeOf("object");
      // At least one client entry must be present.
      const clientKeys = Object.keys(doctor.clients);
      expect(clientKeys.length, `doctor.clients had no keys: ${JSON.stringify(doctor.clients)}`).toBeGreaterThan(0);
    } finally {
      await handshake.mcp.kill();
    }
  });
});
