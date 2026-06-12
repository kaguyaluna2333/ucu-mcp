import { execFileSync } from "node:child_process";
import type { MacOSPlatform } from "./base.js";
import { PlatformError } from "../../util/errors.js";
import { errorMessage } from "./helpers.js";

export async function readClipboard(this: MacOSPlatform): Promise<string> {
  try {
    const out = execFileSync("pbpaste", [], { encoding: "utf-8", timeout: 5000 });
    return out;
  } catch (error) {
    throw new PlatformError(`read_clipboard failed: ${errorMessage(error)}`);
  }
}

export async function writeClipboard(this: MacOSPlatform, text: string): Promise<void> {
  try {
    execFileSync("pbcopy", [], { input: text, encoding: "utf-8", timeout: 5000 });
  } catch (error) {
    throw new PlatformError(`write_clipboard failed: ${errorMessage(error)}`);
  }
}
