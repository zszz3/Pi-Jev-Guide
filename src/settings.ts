import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const stages = [
  "input",
  "tool_call",
  "tool_result",
  "turn_end",
  "turn_start",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "agent_end",
] as const;
export type Stage = (typeof stages)[number];
export type RuleAction = "warn" | "confirm" | "block" | "hide";
export const capabilities: Record<Stage, readonly RuleAction[]> = {
  input: ["warn", "confirm", "block"],
  tool_call: ["warn", "confirm", "block"],
  tool_result: ["warn", "hide"],
  turn_end: ["warn"],
  turn_start: ["warn"],
  tool_execution_start: ["warn"],
  tool_execution_update: ["warn"],
  tool_execution_end: ["warn"],
  agent_end: ["warn"],
};
export const builtinGuards = {
  "local-risk": {
    when: "tool_call",
    description: "本地危险命令和凭据路径检查",
  },
  "semantic-action": {
    when: "tool_call",
    description: "Jev 风险、偏题和 AGENTS 规则检查",
  },
  "redact-output": { when: "tool_result", description: "本地输出脱敏" },
  "semantic-output": { when: "tool_result", description: "Jev 残留凭据检查" },
  "repeated-failure": { when: "tool_result", description: "相同失败三次提醒" },
  "completion-check": { when: "turn_end", description: "缺少验证记录提醒" },
} as const;
export type BuiltinId = keyof typeof builtinGuards;
export interface Rule {
  id: string;
  enabled: boolean;
  when: Stage;
  match?: { tools?: string[]; contains?: string; pathPrefix?: string };
  question?: string;
  threshold: number;
  action: RuleAction;
  onError: RuleAction;
  message: string;
}
export interface Settings {
  version: 1;
  builtins: Record<BuiltinId, boolean>;
  rules: Rule[];
}
export function defaultSettings(): Settings {
  return {
    version: 1,
    builtins: Object.fromEntries(
      Object.keys(builtinGuards).map((id) => [id, true]),
    ) as Settings["builtins"],
    rules: [],
  };
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label}: expected object`);
  return value as Record<string, unknown>;
}
function keys(obj: Record<string, unknown>, allowed: string[], label: string) {
  for (const key of Object.keys(obj))
    if (!allowed.includes(key))
      throw new Error(`${label}: unknown field ${key}`);
}
function string(value: unknown, label: string, max = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${label}: expected non-empty string (max ${max})`);
  return value;
}
/** Validate the whole document before replacing live settings; never silently drop a rule. */
export function parseSettings(value: unknown): Settings {
  const raw = object(value, "config");
  keys(raw, ["version", "builtins", "rules"], "config");
  if (raw.version !== 1) throw new Error("config.version must be 1");
  const result = defaultSettings();
  if (raw.builtins !== undefined) {
    const builtins = object(raw.builtins, "builtins");
    keys(builtins, Object.keys(builtinGuards), "builtins");
    for (const [id, enabled] of Object.entries(builtins)) {
      if (typeof enabled !== "boolean")
        throw new Error(`builtins.${id}: expected boolean`);
      result.builtins[id as BuiltinId] = enabled;
    }
  }
  if (raw.rules === undefined) return result;
  if (!Array.isArray(raw.rules) || raw.rules.length > 32)
    throw new Error("rules: expected array of at most 32 rules");
  const ids = new Set(Object.keys(builtinGuards));
  result.rules = raw.rules.map((entry, index) => {
    const label = `rules[${index}]`;
    const r = object(entry, label);
    keys(
      r,
      [
        "id",
        "enabled",
        "when",
        "match",
        "question",
        "threshold",
        "action",
        "onError",
        "message",
      ],
      label,
    );
    const id = string(r.id, `${label}.id`, 64);
    if (!/^[a-z][a-z0-9-]*$/.test(id) || ids.has(id))
      throw new Error(`${label}: invalid or duplicate id`);
    ids.add(id);
    if (r.enabled !== undefined && typeof r.enabled !== "boolean")
      throw new Error(`${label}.enabled: expected boolean`);
    if (!stages.includes(r.when as Stage))
      throw new Error(`${label}: unsupported when`);
    const when = r.when as Stage;
    if (!capabilities[when].includes(r.action as RuleAction))
      throw new Error(
        `${label}: ${String(r.action)} is not supported at ${when}`,
      );
    const onError =
      r.onError ??
      (when === "tool_result"
        ? "hide"
        : capabilities[when].includes("block")
          ? "block"
          : "warn");
    if (!capabilities[when].includes(onError as RuleAction))
      throw new Error(`${label}: unsupported onError for ${when}`);
    const threshold = r.threshold ?? 0.9;
    if (
      typeof threshold !== "number" ||
      !Number.isFinite(threshold) ||
      threshold <= 0 ||
      threshold > 1
    )
      throw new Error(`${label}: threshold must be > 0 and <= 1`);
    let match: Rule["match"];
    if (r.match !== undefined) {
      const m = object(r.match, `${label}.match`);
      keys(m, ["tools", "contains", "pathPrefix"], `${label}.match`);
      match = {};
      if (m.tools !== undefined) {
        if (
          !when.startsWith("tool_") ||
          !Array.isArray(m.tools) ||
          m.tools.length === 0 ||
          m.tools.length > 64
        )
          throw new Error(
            `${label}: tools requires a tool stage and non-empty array`,
          );
        match.tools = m.tools.map((tool) =>
          string(tool, `${label}.match.tools`, 100),
        );
      }
      if (m.contains !== undefined)
        match.contains = string(m.contains, `${label}.match.contains`);
      if (m.pathPrefix !== undefined) {
        if (!when.startsWith("tool_"))
          throw new Error(`${label}: pathPrefix requires a tool stage`);
        match.pathPrefix = string(m.pathPrefix, `${label}.match.pathPrefix`);
      }
    }
    const question =
      r.question === undefined
        ? undefined
        : string(r.question, `${label}.question`);
    if (!question && (!match || Object.keys(match).length === 0))
      throw new Error(`${label}: match or question is required`);
    return {
      id,
      enabled: r.enabled !== false,
      when,
      match,
      question,
      threshold,
      action: r.action as RuleAction,
      onError: onError as RuleAction,
      message: string(r.message, `${label}.message`),
    };
  });
  return result;
}
export function loadSettings(path: string): Settings {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return defaultSettings();
    throw error;
  }
  if (raw.length > 128000) throw new Error("config exceeds 128000 characters");
  return parseSettings(JSON.parse(raw));
}
export function saveSettings(path: string, settings: Settings): void {
  const validated = parseSettings(settings);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(validated, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, path);
}
