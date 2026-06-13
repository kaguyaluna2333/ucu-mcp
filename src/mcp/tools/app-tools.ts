import { z } from "zod";
import type { AppTarget } from "../../platform/base.js";
import { checkPermission } from "../../safety/permissions.js";
import { PermissionError } from "../../util/errors.js";
import { createLogger } from "../../util/logger.js";
import { metrics } from "../../util/metrics.js";
import {
  type RegisterToolFn,
  type ToolResult,
  getPlatform,
  getActiveTarget,
  setActiveTarget,
  withSafety,
  jsonText,
} from "./helpers.js";

const log = createLogger("tools");

export function registerAppTools(registerTool: RegisterToolFn): void {
  registerTool("list_apps", "List all running applications", {}, async () => {
    const apps = await withSafety({ action: "list_apps", params: {}, requiresAccessibility: true, execute: async () => getPlatform().listApps!() });
    return { content: [{ type: "text", text: JSON.stringify(apps, null, 2) }] };
  });

  registerTool("focus_app", "Select an application/window as the active target context", {
    app: z.string().describe("Application name to focus"),
  }, async (params) => {
    const target = await withSafety<AppTarget>({ action: "focus_app", params: {}, requiresAccessibility: true, execute: () => getPlatform().focusApp!(params.app) });
    setActiveTarget(target);
    return { content: [{ type: "text", text: JSON.stringify(target, null, 2) }] };
  });

  registerTool("wait", "Wait for a specified duration", { ms: z.number().int().min(1).max(60000).describe("Duration in milliseconds (1–60000)") }, async (params) => {
    await new Promise(r => setTimeout(r, params.ms));
    return { content: [{ type: "text", text: JSON.stringify({ waited: params.ms }) }] };
  });

  registerTool("wait_for_element", "Poll until an accessibility element matching the criteria reaches the desired state", {
    text: z.string().optional().describe("Element text"), role: z.string().optional().describe("Element role"),
    app: z.string().optional().describe("Target app"),
    timeout: z.number().optional().describe("Timeout ms (default 5000)"),
    timeoutMs: z.number().optional().describe("Alias for timeout"),
    interval: z.number().optional().describe("Poll interval ms (default 500)"),
    intervalMs: z.number().optional().describe("Alias for interval"),
    until: z.enum(["appear", "disappear", "value_change"]).default("appear").describe("Wait condition: 'appear' (default) waits for a match, 'disappear' waits until no match, 'value_change' waits until first match's value changes"),
  }, async (params) => {
    const deadline = Date.now() + (params.timeout ?? params.timeoutMs ?? 5000);
    const interval = params.interval ?? params.intervalMs ?? 500;
    const until = params.until ?? "appear";
    const effectiveApp = params.app || getActiveTarget()?.appName;
    const query = { text: params.text, role: params.role, app: effectiveApp, maxResults: 1 };
    const { granted } = await checkPermission("accessibility");
    if (!granted) throw new PermissionError("accessibility", process.platform);
    let initialValue: string | undefined;
    let hasInitial = false;
    while (Date.now() < deadline) {
      const response = await getPlatform().findElement(query);
      const matched = response.results[0];
      if (until === "appear") {
        if (matched) return { content: [{ type: "text", text: JSON.stringify({ found: true, element: matched }, null, 2) }] };
      } else if (until === "disappear") {
        if (!matched) return { content: [{ type: "text", text: JSON.stringify({ found: true, reason: "disappeared" }, null, 2) }] };
      } else {
        if (matched) {
          if (!hasInitial) {
            initialValue = matched.value;
            hasInitial = true;
          } else if (matched.value !== initialValue) {
            return { content: [{ type: "text", text: JSON.stringify({ found: true, oldValue: initialValue, newValue: matched.value }, null, 2) }] };
          }
        }
      }
      await new Promise(r => setTimeout(r, interval));
    }
    const reason = until === "value_change" ? (hasInitial ? "value_unchanged" : "never_appeared") : "timeout";
    return { content: [{ type: "text", text: JSON.stringify({ found: false, reason }, null, 2) }] };
  });

  registerTool("doctor", "Check system permissions, native helpers, and client readiness", {}, async () => {
    const { checkPermissions, getPermissionInstructions, getTerminalAppName } = await import("../../safety/permissions.js");
    const { existsSync, statSync } = await import("node:fs");
    const { join, dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { execFileSync } = await import("node:child_process");
    const permissions = await checkPermissions();
    const screenLocked = getPlatform().isScreenLocked?.() ?? false;
    const termApp = process.platform === "darwin" ? getTerminalAppName() : undefined;

    function resolveHelperPath(relParts: string[]): { path: string | null; tried: readonly string[] } {
      const tried: string[] = [];
      const tryPaths: string[] = [];
      const moduleDir = dirname(fileURLToPath(import.meta.url));
      const argv1 = process.argv[1] ? resolve(process.argv[1]) : "";
      const argv1Dir = argv1 ? dirname(argv1) : "";
      tryPaths.push(join(process.cwd(), ...relParts));
      if (argv1Dir) {
        tryPaths.push(join(argv1Dir, ...relParts));
        tryPaths.push(join(argv1Dir, "..", ...relParts));
        tryPaths.push(join(argv1Dir, "..", "..", ...relParts));
      }
      tryPaths.push(join(moduleDir, "..", ...relParts));
      tryPaths.push(join(moduleDir, "..", "..", ...relParts));
      tryPaths.push(join(moduleDir, "..", "..", "..", ...relParts));
      tryPaths.push(join(moduleDir, "..", "..", "..", "..", ...relParts));
      if (process.platform === "darwin") {
        try {
          const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf-8", timeout: 2000 }).trim();
          if (npmRoot) {
            tryPaths.push(join(npmRoot, "ucu-mcp", ...relParts));
          }
        } catch { /* npm not on PATH is fine */ }
      }
      for (const p of tryPaths) {
        tried.push(p);
        try {
          if (existsSync(p) && statSync(p).isFile()) return { path: p, tried };
        } catch { /* skip */ }
      }
      return { path: null, tried };
    }

    let nativeHelpers:
      | { cgevent: { ok: boolean; path: string | null; tried: readonly string[] };
          ocr: { ok: boolean; path: string | null; tried: readonly string[] };
          windowlist: { ok: boolean; path: string | null; tried: readonly string[] } }
      | undefined;
    if (process.platform === "darwin") {
      const cgevent = resolveHelperPath(["native", "cgevent", "cgevent-helper"]);
      const ocr = resolveHelperPath(["native", "ocr", "ocr-helper"]);
      const windowlist = resolveHelperPath(["native", "windowlist", "windowlist-helper"]);
      nativeHelpers = {
        cgevent: { ok: cgevent.path !== null, path: cgevent.path, tried: cgevent.tried },
        ocr: { ok: ocr.path !== null, path: ocr.path, tried: ocr.tried },
        windowlist: { ok: windowlist.path !== null, path: windowlist.path, tried: windowlist.tried },
      };
    }

    let readiness: "ready" | "degraded" | "blocked" = "ready";
    const issues: string[] = [];
    if (!permissions.granted) {
      readiness = "blocked";
      for (const m of (permissions.missing ?? []) as Array<"accessibility" | "screenRecording">) {
        issues.push(`Missing macOS permission: ${m}`);
      }
    }
    if (screenLocked) {
      readiness = "blocked";
      issues.push("Screen is locked");
    }
    if (process.platform === "darwin" && nativeHelpers) {
      if (!nativeHelpers.cgevent.ok) {
        readiness = readiness === "ready" ? "degraded" : readiness;
        issues.push("Native CGEvent helper not found (input synthesis may crash on macOS Sequoia+). Run `npm run build` to compile it, or reinstall ucu-mcp so the helper ships from the tarball.");
      }
      if (!nativeHelpers.ocr.ok) {
        readiness = readiness === "ready" ? "degraded" : readiness;
        issues.push("Native OCR helper not found (OCR may fail on macOS Sequoia+). Run `npm run build` to compile it, or reinstall ucu-mcp so the helper ships from the tarball.");
      }
      if (!nativeHelpers.windowlist.ok) {
        readiness = readiness === "ready" ? "degraded" : readiness;
        issues.push("Native windowlist helper not found (window enumeration will fall back to slow JXA). Run `npm run build` to compile it.");
      }
    }

    const electronHint = "If the target app is Electron (e.g. CC Switch, VS Code, Discord), list_windows may return [] even with Accessibility granted to your terminal. Grant Accessibility to the Electron app itself in System Settings > Privacy & Security > Accessibility, and restart the app. Pixel-level workaround: use screenshot + ocr to locate UI elements by text, then click(x, y) at the detected bounding box coordinates. Alternatively, modify the app\'s config file or database directly.";

    const clients: Record<string, string> = {};
    for (const bin of ["claude", "codex", "opencode", "npx"]) {
      try {
        const path = execFileSync("which", [bin], { encoding: "utf-8", timeout: 2000 }).trim();
        clients[bin] = path || "not found";
      } catch {
        clients[bin] = "not found";
      }
    }

    const recommendations: string[] = [];
    if (readiness === "blocked") {
      for (const m of (permissions.missing ?? []) as Array<"accessibility" | "screenRecording">) {
        const app = termApp ?? "your terminal app";
        recommendations.push(`${m}: ${getPermissionInstructions(m)} (Grant to ${app}.)`);
      }
      if (screenLocked) recommendations.push("Unlock the screen, then retry.");
    }
    if (readiness !== "ready") {
      if (process.platform === "darwin" && nativeHelpers && (!nativeHelpers.cgevent.ok || !nativeHelpers.ocr.ok)) {
        recommendations.push("Run `npm run build` in the ucu-mcp project to compile native Swift helpers (cgevent-helper, ocr-helper, windowlist-helper).");
      }
      if (process.platform === "darwin" && nativeHelpers && !nativeHelpers.windowlist.ok) {
        recommendations.push("windowlist helper missing — list_windows will fall back to JXA (~3-6s, unreliable for Electron). Run `npm run build`.");
      }
    }
    if (readiness === "ready") {
      recommendations.push("All checks passed. MCP client can proceed with automation.");
    } else if (process.platform === "darwin") {
      recommendations.push(electronHint);
    }

    const report = {
      readiness,
      issues: issues.length > 0 ? issues : undefined,
      recommendations,
      platform: process.platform,
      node: process.version,
      permissions,
      screenLocked,
      terminalApp: termApp,
      nativeHelpers,
      clients,
      safety: {
        urlBlocklist: true,
        lockScreenGuard: process.platform === "darwin",
        typedTextInjectionScan: true,
      },
      stdioCommand: "ucu-mcp",
      metrics: {
        global: metrics.stats(),
        byTool: metrics.byTool(),
      },
    };
    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  });

  registerTool("clipboard_read", "Read the current contents of the system clipboard", {}, async () => {
    const text = await withSafety<string>({ action: "clipboard_read", params: {}, execute: () => getPlatform().readClipboard() });
    return { content: [{ type: "text", text: JSON.stringify({ text }, null, 2) }] };
  });

  registerTool("clipboard_write", "Write text to the system clipboard (text injection patterns are blocked)", {
    text: z.string().describe("Text to place on the clipboard"),
  }, async (params) => {
    await withSafety<void>({ action: "clipboard_write", params: { text: params.text }, execute: () => getPlatform().writeClipboard(params.text) });
    return { content: [{ type: "text", text: JSON.stringify({ written: true }, null, 2) }] };
  });
}
