import { open } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { bounded } from "./redact.ts";

/** Re-read applicable rule files so edits take effect without restarting Pi. */
export async function readRules(
  cwd: string,
  target?: string,
  loadedPaths: readonly string[] = [],
): Promise<string> {
  const paths = new Set(
    loadedPaths.filter((path) => /(?:^|[/\\])AGENTS\.md$/i.test(path)),
  );
  const root = resolve(cwd);
  paths.add(join(root, "AGENTS.md"));
  if (target) {
    const parent = dirname(resolve(root, target));
    const rel = relative(root, parent);
    if (
      rel &&
      !rel.startsWith(`..${sep}`) &&
      rel !== ".." &&
      !rel.startsWith(sep)
    ) {
      let current = root;
      for (const part of rel.split(sep).slice(0, 20)) {
        current = join(current, part);
        paths.add(join(current, "AGENTS.md"));
      }
    }
  }
  const chunks: string[] = [];
  for (const path of [...paths].slice(0, 24)) {
    try {
      const file = await open(path, "r");
      try {
        const buffer = Buffer.alloc(10001);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        chunks.push(
          `${path}\n${bounded(buffer.subarray(0, bytesRead).toString("utf8"), 10000)}`,
        );
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        chunks.push(`${path}: [rules unavailable; do not assume compliance]`);
    }
  }
  return bounded(chunks.join("\n\n"), 10000);
}
