import { execFileSync } from "node:child_process";
import type { MacOSPlatform } from "./base.js";

/**
 * @deprecated Focus management is intentionally disabled. CGEvent input
 * synthesis (click/type/key) works at the HID layer and does not require the
 * target app to be frontmost, so stealing/restoring focus is unnecessary and
 * could disrupt the user. `saveFocus`/`restoreFocus` are retained for API
 * compatibility but are NOT called from the action pipeline — see the
 * `not.toHaveBeenCalled()` assertions in `tools-layer.test.ts` that lock this
 * disabled state. Do not wire these into new code; prefer CGEvent-based input.
 */
export async function saveFocus(this: MacOSPlatform): Promise<void> {
  try {
    const apps = await this.listApps();
    const front = apps.find((a) => a.isFrontmost);
    if (front) {
      const windows = await this.listWindows();
      const win = windows.find((w) => w.processName === front.name && w.isOnScreen);
      this.savedFocus = {
        appName: front.name,
        windowTitle: win?.title ?? "",
      };
    }
  } catch {
    this.savedFocus = undefined;
  }
}

/** @deprecated See {@link saveFocus} — intentionally disabled, not called from the action pipeline. */
export async function restoreFocus(this: MacOSPlatform): Promise<void> {
  if (!this.savedFocus) return;
  try {
    const { appName } = this.savedFocus;
    const appNameLiteral = JSON.stringify(appName);
    execFileSync("osascript", [
      "-e", `tell application ${appNameLiteral} to activate`,
    ], { timeout: 5000 });
  } catch {
    // Best effort — don't fail the action if restore fails
  }
  this.savedFocus = undefined;
}
