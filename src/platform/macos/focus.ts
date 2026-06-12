import { execFileSync } from "node:child_process";
import type { MacOSPlatform } from "./base.js";

export async function saveFocus(this: MacOSPlatform): Promise<void> {
  try {
    const apps = await this.listApps();
    const front = apps.find((a) => a.isFrontmost);
    if (front) {
      const windows = await this.listWindows();
      const win = windows.find((w) => w.processName === front.name && w.isOnScreen);
      (this as any).savedFocus = {
        appName: front.name,
        windowTitle: win?.title ?? "",
      };
    }
  } catch {
    (this as any).savedFocus = undefined;
  }
}

export async function restoreFocus(this: MacOSPlatform): Promise<void> {
  if (!(this as any).savedFocus) return;
  try {
    const { appName } = (this as any).savedFocus;
    const appNameLiteral = JSON.stringify(appName);
    execFileSync("osascript", [
      "-e", `tell application ${appNameLiteral} to activate`,
    ], { timeout: 5000 });
  } catch {
    // Best effort — don't fail the action if restore fails
  }
  (this as any).savedFocus = undefined;
}
