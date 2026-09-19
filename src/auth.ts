import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth } from "@earendil-works/pi-tui";

export function validateApiKey(value: string): string {
  const key = value.trim();
  if (!/^[\x21-\x7e]{1,4096}$/.test(key))
    throw new Error("Invalid API key format");
  return key;
}
export function readApiKey(path: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Cannot read saved API key");
  }
  try {
    if (text.length > 8192) throw new Error();
    const data = JSON.parse(text);
    if (data.version !== 1 || typeof data.apiKey !== "string")
      throw new Error();
    return validateApiKey(data.apiKey);
  } catch {
    throw new Error("Invalid saved API key");
  }
}
export function saveApiKey(path: string, value: string): void {
  const apiKey = validateApiKey(value);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, apiKey }) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
export function deleteApiKey(path: string): void {
  rmSync(path, { force: true });
}

/** Use native paste/edit handling, but never render the underlying plaintext input. */
export class SecretInput {
  private input = new Input();
  constructor(done: (value: string | undefined) => void) {
    this.input.onSubmit = (value) => {
      this.input.setValue("");
      done(value);
    };
    this.input.onEscape = () => {
      this.input.setValue("");
      done(undefined);
    };
  }
  get focused() {
    return this.input.focused;
  }
  set focused(value: boolean) {
    this.input.focused = value;
  }
  handleInput(data: string) {
    this.input.handleInput(data);
  }
  invalidate() {
    this.input.invalidate();
  }
  render(width: number): string[] {
    return [
      "TypeSafe API key（隐藏输入）",
      "API key: " +
        "*".repeat(
          Math.min(this.input.getValue().length, Math.max(0, width - 12)),
        ),
      "Enter：验证并保存 · Esc：取消",
      "保存至 Pi 用户目录；验证只发送固定测试文本。",
    ].map((line) => truncateToWidth(line, width));
  }
}
export function promptApiKey(
  ctx: ExtensionContext,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>(
    (_tui, _theme, _kb, done) => new SecretInput(done),
  );
}
