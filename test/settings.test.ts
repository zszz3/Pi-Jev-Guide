import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSettings, loadSettings, saveSettings } from "../src/settings.ts";
import { evaluateRules, matches, type GuardEvent } from "../src/engine.ts";

const example = {
  id: "release-review",
  when: "tool_call",
  match: { tools: ["bash"], contains: "npm publish" },
  action: "confirm",
  message: "请确认此次发布",
};
const parse = (rule: unknown = example) =>
  parseSettings({ version: 1, rules: [rule] });
const event: GuardEvent = {
  when: "tool_call",
  cwd: "/project",
  task: "release",
  tool: "bash",
  input: { command: "npm publish" },
  text: '{"command":"npm publish"}',
};

test("reject unsupported event/action pairs instead of pretending to block finished work", () => {
  for (const when of ["tool_result", "turn_end"])
    assert.throws(
      () => parse({ ...example, when, action: "block" }),
      /not supported/,
    );
  assert.throws(
    () => parse({ ...example, when: "made_up" }),
    /unsupported when/,
  );
  assert.throws(() => parse({ ...example, action: "allow" }), /not supported/);
});
test("strict validation rejects duplicate ids, typos, unbounded rules and invalid failure policy", () => {
  assert.throws(
    () => parseSettings({ version: 1, rules: [example, example] }),
    /duplicate/,
  );
  assert.throws(() => parse({ ...example, threhsold: 0.2 }), /unknown field/);
  assert.throws(() => parse({ ...example, threshold: 2 }), /threshold/);
  assert.throws(() => parse({ ...example, onError: "hide" }), /onError/);
  assert.throws(
    () => parseSettings({ version: 1, rules: Array(33).fill(example) }),
    /at most/,
  );
  assert.throws(
    () => parse({ ...example, match: {}, question: undefined }),
    /required/,
  );
});
test("multiple selectors are ANDed and disabling a rule prevents matching", () => {
  const rule = parse().rules[0];
  assert.equal(matches(rule, event), true);
  assert.equal(matches(rule, { ...event, tool: "write" }), false);
  assert.equal(matches(rule, { ...event, text: "npm test" }), false);
  assert.equal(matches({ ...rule, enabled: false }, event), false);
});
test("path prefix uses path boundaries and resolves traversal", () => {
  const rule = parse({ ...example, match: { pathPrefix: "src" } }).rules[0];
  assert.equal(matches(rule, { ...event, input: { path: "src/a.ts" } }), true);
  assert.equal(
    matches(rule, { ...event, input: { path: "src-other/a.ts" } }),
    false,
  );
  assert.equal(
    matches(rule, { ...event, input: { path: "src/../secret" } }),
    false,
  );
  assert.equal(matches(rule, event), false);
});
test("local rules need no Jev and stay effective alongside unavailable semantic rules", async () => {
  const settings = parseSettings({
    version: 1,
    rules: [
      example,
      {
        ...example,
        id: "meaning",
        question: "Is this a release?",
        onError: "warn",
      },
    ],
  });
  const findings = await evaluateRules(settings.rules, event);
  assert.deepEqual(
    findings.map((f) => [f.id, f.action, f.unavailable]),
    [
      ["release-review", "confirm", false],
      ["meaning", "warn", true],
    ],
  );
});
test("semantic questions batch only matched rules and always redact outbound state", async () => {
  const settings = parseSettings({
    version: 1,
    rules: [
      { ...example, question: "Is this a release?" },
      {
        ...example,
        id: "skip",
        match: { tools: ["write"] },
        question: "skip?",
      },
    ],
  });
  let calls = 0;
  const findings = await evaluateRules(
    settings.rules,
    { ...event, task: "synthetic-secret-value" },
    {
      evaluate: async (state, questions) => {
        calls++;
        assert.ok(!state.includes("synthetic-secret-value"));
        assert.deepEqual(Object.keys(questions), ["release-review"]);
        return { "release-review": 0.95 };
      },
    },
    ["synthetic-secret-value"],
  );
  assert.equal(calls, 1);
  assert.equal(findings[0].action, "confirm");
});
test("invalid semantic response and oversized context use declared fallback", async () => {
  const settings = parse({ ...example, question: "Risk?" });
  assert.equal(
    (
      await evaluateRules(settings.rules, event, { evaluate: async () => ({}) })
    )[0].action,
    "block",
  );
  let called = false;
  assert.equal(
    (
      await evaluateRules(
        settings.rules,
        { ...event, task: "x".repeat(17000) },
        {
          evaluate: async () => {
            called = true;
            return {};
          },
        },
      )
    )[0].unavailable,
    true,
  );
  assert.equal(called, false);
});
test("cancelled rule evaluation cannot authorize the pending action", async () => {
  const controller = new AbortController();
  await assert.rejects(
    evaluateRules(
      parse({ ...example, question: "Risk?" }).rules,
      event,
      {
        evaluate: async () => {
          controller.abort();
          return { "release-review": 0 };
        },
      },
      [],
      controller.signal,
    ),
  );
});
test("settings round trip without losing custom rules; malformed saved JSON is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-settings-"));
  try {
    const path = join(dir, "config.json");
    assert.equal(loadSettings(path).rules.length, 0);
    const settings = parse();
    settings.builtins["completion-check"] = false;
    saveSettings(path, settings);
    assert.deepEqual(loadSettings(path), settings);
    writeFileSync(path, "{");
    assert.throws(() => loadSettings(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime notification stages reject blocking and hiding", () => {
  for(const when of ["turn_start","tool_execution_start","tool_execution_update","tool_execution_end","agent_end"]){
    for(const action of ["block","confirm","hide"]){
      assert.throws(()=>parseSettings({version:1,rules:[{id:"runtime",when,action,message:"Review"}]}));
    }
    assert.equal(parseSettings({version:1,rules:[{id:"runtime",when,match:{contains:"test"},action:"warn",message:"Review"}]}).rules[0].when,when);
  }
});
