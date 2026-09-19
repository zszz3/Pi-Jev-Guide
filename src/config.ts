export type Mode = "guard" | "observe";

export interface Config {
  mode: Mode;
  apiKey?: string;
  knownSecrets: readonly string[];
  model: string;
  timeoutMs: number;
  destructiveThreshold: number;
  leakThreshold: number;
  warningThreshold: number;
  scanOutput: boolean;
}

/** Transport credentials and default thresholds come from the process environment. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env.JEV_GUARD_MODE ?? "guard";
  if (mode !== "guard" && mode !== "observe")
    throw new Error("JEV_GUARD_MODE must be guard or observe");
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isFinite(value) || value < min || value > max)
      throw new Error(`Invalid ${key}`);
    return value;
  };
  const scan = env.JEV_GUARD_SCAN_OUTPUT ?? "true";
  if (scan !== "true" && scan !== "false")
    throw new Error("JEV_GUARD_SCAN_OUTPUT must be true or false");
  return {
    mode,
    apiKey: env.TYPESAFE_API_KEY?.trim() || undefined,
    knownSecrets: Object.entries(env)
      .filter(
        ([key, value]) =>
          /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)/i.test(key) &&
          value &&
          value.length >= 8,
      )
      .map(([, value]) => value!),
    model: env.JEV_GUARD_MODEL?.trim() || "jev-latest",
    timeoutMs: number("JEV_GUARD_TIMEOUT_MS", 2500, 100, 30000),
    destructiveThreshold: number(
      "JEV_GUARD_DESTRUCTIVE_THRESHOLD",
      0.9,
      0.01,
      1,
    ),
    leakThreshold: number("JEV_GUARD_LEAK_THRESHOLD", 0.9, 0.01, 1),
    warningThreshold: number("JEV_GUARD_WARNING_THRESHOLD", 0.85, 0.01, 1),
    scanOutput: scan === "true",
  };
}
