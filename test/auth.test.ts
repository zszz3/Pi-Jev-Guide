import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  readApiKey,
  saveApiKey,
  deleteApiKey,
  SecretInput,
} from "../src/auth.ts";

test("saved key persists with private permissions and can be deleted", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-auth-"));
  const path = join(dir, "credentials", "auth.json");
  try {
    assert.equal(readApiKey(path), undefined);
    saveApiKey(path, "synthetic-test-key");
    assert.equal(readApiKey(path), "synthetic-test-key");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
    saveApiKey(path, "synthetic-replacement");
    assert.equal(readApiKey(path), "synthetic-replacement");
    deleteApiKey(path);
    assert.equal(readApiKey(path), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("invalid key and corrupt credentials fail without putting input in errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-auth-"));
  const path = join(dir, "auth.json");
  try {
    saveApiKey(path, "synthetic-original");
    assert.throws(
      () => saveApiKey(path, "synthetic bad value"),
      /Invalid API key format/,
    );
    assert.equal(readApiKey(path), "synthetic-original");
    writeFileSync(path, "synthetic-corrupt-data");
    assert.throws(
      () => readApiKey(path),
      (error) =>
        error instanceof Error &&
        !error.message.includes("synthetic-corrupt-data"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("secret input masks typed and pasted keys, submits without rendering plaintext", () => {
  let submitted: string | undefined;
  const input = new SecretInput((value) => {
    submitted = value;
  });
  input.focused = true;
  input.handleInput("\x1b[200~synthetic-secret\x1b[201~");
  assert.ok(!input.render(80).join("\n").includes("synthetic-secret"));
  assert.ok(input.render(80).some((line) => line.includes("***")));
  input.handleInput("\r");
  assert.equal(submitted, "synthetic-secret");
  assert.ok(!input.render(80).some((line) => line.includes("***")));
});
test("escape cancels credential input", () => {
  let cancelled = false;
  const input = new SecretInput((value) => {
    cancelled = value === undefined;
  });
  input.handleInput("synthetic-secret");
  input.handleInput("\x1b");
  assert.equal(cancelled, true);
});
