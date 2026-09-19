import { resolve, relative, isAbsolute } from "node:path";
import type { Judge } from "./judge.ts";
import { redact } from "./redact.ts";
import type { Rule, RuleAction, Stage } from "./settings.ts";

export interface GuardEvent {
  when: Stage;
  cwd: string;
  task: string;
  text: string;
  tool?: string;
  input?: Record<string, unknown>;
}
export interface Finding {
  id: string;
  action: RuleAction;
  message: string;
  unavailable: boolean;
}
/** All supplied selectors must match. Path selectors only inspect an explicit input.path. */
export function matches(rule: Rule, event: GuardEvent): boolean {
  if (!rule.enabled || rule.when !== event.when) return false;
  const match = rule.match;
  if (match?.tools && !match.tools.includes(event.tool ?? "")) return false;
  if (match?.contains && !event.text.includes(match.contains)) return false;
  if (match?.pathPrefix) {
    if (typeof event.input?.path !== "string") return false;
    const subpath = relative(
      resolve(event.cwd, match.pathPrefix),
      resolve(event.cwd, event.input.path),
    );
    if (subpath === ".." || subpath.startsWith("../") || isAbsolute(subpath))
      return false;
  }
  return true;
}
/** Pi-independent rule engine. It decides; the adapter alone prompts, blocks or changes output. */
export async function evaluateRules(
  rules: readonly Rule[],
  event: GuardEvent,
  judge?: Judge,
  secrets: readonly string[] = [],
  signal?: AbortSignal,
): Promise<Finding[]> {
  const selected = rules.filter((rule) => matches(rule, event));
  const semantic = selected.filter((rule) => rule.question);
  const state = redact(JSON.stringify(event), secrets);
  let scores: Record<string, number> = {};
  let unavailable = false;
  signal?.throwIfAborted();
  if (semantic.length) {
    try {
      if (!judge || state.length > 16000)
        throw new Error("Semantic check unavailable");
      scores = await judge.evaluate(
        state,
        Object.fromEntries(semantic.map((rule) => [rule.id, rule.question!])),
        signal,
      );
      for (const rule of semantic)
        if (
          !Number.isFinite(scores[rule.id]) ||
          scores[rule.id] < 0 ||
          scores[rule.id] > 1
        )
          throw new Error("Invalid score");
    } catch {
      signal?.throwIfAborted();
      unavailable = true;
    }
  }
  signal?.throwIfAborted();
  return selected.flatMap<Finding>((rule) => {
    if (rule.question && unavailable)
      return [
        {
          id: rule.id,
          action: rule.onError,
          message: `规则 ${rule.id} 的语义检查未完成。${rule.message}`,
          unavailable: true,
        },
      ];
    if (rule.question && scores[rule.id] < rule.threshold) return [];
    return [
      {
        id: rule.id,
        action: rule.action,
        message: rule.message,
        unavailable: false,
      },
    ];
  });
}
