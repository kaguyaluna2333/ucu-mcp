import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
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
