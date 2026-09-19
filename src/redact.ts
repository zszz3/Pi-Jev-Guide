const replacement = "[REDACTED:credential]";

/** Heuristic text redaction, not a guarantee that arbitrary secrets are recognizable. */
export function redact(
  text: string,
  knownSecrets: readonly string[] = [],
): string {
  let result = text;
  for (const secret of knownSecrets) {
    if (secret.length >= 8) result = result.split(secret).join(replacement);
  }
  return result
    .replace(
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g,
      replacement,
    )
    .replace(
      /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{15,}|AKIA[A-Z0-9]{16})\b/g,
      replacement,
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      replacement,
    )
    .replace(
      /(\b(?:authorization["']?\s*[:=]\s*["']?(?:bearer|basic)\s+))[^\s"'`,;]+/gi,
      `$1${replacement}`,
    )
    .replace(
      /((?:["']?\b[\w.-]*(?:api[_-]?key|access[_-]?token|secret|password|passwd|private[_-]?key)[\w.-]*["']?)\s*[:=]\s*)(["'])([^\r\n]*?)\2/gi,
      `$1"${replacement}"`,
    )
    .replace(
      /(\b[\w.-]*(?:api[_-]?key|access[_-]?token|secret|password|passwd)[\w.-]*\s*[:=]\s*)(?!["'\[])[^\s,;}]+/gi,
      `$1${replacement}`,
    )
    .replace(
      /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi,
      `$1${replacement}$2`,
    );
}

/** Redact text embedded in tool metadata as well as its displayed text. */
export function redactValue(
  value: unknown,
  secrets: readonly string[] = [],
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") return redact(value, secrets);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular metadata omitted]";
  seen.add(value);
  if (Array.isArray(value))
    return value.map((item) => redactValue(item, secrets, seen));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const sensitive =
      /(?:password|passwd|secret|api[_-]?key|access[_-]?token|authorization|private[_-]?key)/i.test(
        key,
      );
    Object.defineProperty(result, redact(key, secrets), {
      value:
        sensitive && item != null
          ? replacement
          : redactValue(item, secrets, seen),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

export function bounded(text: string, max = 12000): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n[TRUNCATED: remaining content was not semantically reviewed]`;
}
