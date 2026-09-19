import { createHash } from "node:crypto";
import { isSourceWrite, isVerification, type Action } from "./policy.ts";

export interface Snapshot {
  version: 1;
  revision: number;
  verifiedRevision: number;
  requestStartRevision: number;
  completionNotified: boolean;
}
interface Pending {
  revision: number;
  mutation: boolean;
  verification: boolean;
  noConcurrentWrites: boolean;
}

/** Deterministic evidence tracking; a model score never becomes test-pass evidence. */
export class Tracker {
  revision = 0;
  verifiedRevision = 0;
  requestStartRevision = 0;
  completionNotified = false;
  private pending = new Map<string, Pending>();
  private failures = new Map<string, number>();

  begin(id: string, action: Action): void {
    const mutation = isSourceWrite(action);
    if (mutation) this.revision++;
    this.pending.set(id, {
      revision: this.revision,
      mutation,
      verification:
        action.tool === "bash" &&
        isVerification(String(action.input.command ?? "")),
      noConcurrentWrites: ![...this.pending.values()].some(
        (entry) => entry.mutation,
      ),
    });
  }

  finish(id: string, action: Action, error: boolean, result: string): boolean {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    if (
      pending?.verification &&
      !error &&
      pending.noConcurrentWrites &&
      pending.revision === this.revision &&
      ![...this.pending.values()].some((entry) => entry.mutation)
    ) {
      this.verifiedRevision = this.revision;
    }
    const key = createHash("sha256")
      .update(JSON.stringify([action.tool, action.input]))
      .digest("hex");
    if (!error) {
      for (const entry of this.failures.keys())
        if (entry.startsWith(key)) this.failures.delete(entry);
      return false;
    }
    const signature =
      key +
      createHash("sha256")
        .update(result.trim().replace(/\s+/g, " ").slice(0, 4000))
        .digest("hex");
    const count = (this.failures.get(signature) ?? 0) + 1;
    this.failures.set(signature, count);
    if (this.failures.size > 64)
      this.failures.delete(this.failures.keys().next().value!);
    return count === 3;
  }

  newRequest(): void {
    this.requestStartRevision = this.revision;
    this.completionNotified = false;
    this.failures.clear();
  }
  needsVerification(): boolean {
    return (
      this.revision >
        Math.max(this.verifiedRevision, this.requestStartRevision) &&
      !this.completionNotified
    );
  }
  snapshot(): Snapshot {
    return {
      version: 1,
      revision: this.revision,
      verifiedRevision: this.verifiedRevision,
      requestStartRevision: this.requestStartRevision,
      completionNotified: this.completionNotified,
    };
  }
  restore(data: unknown): void {
    if (!data || typeof data !== "object") return;
    const value = data as Partial<Snapshot>;
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.revision) ||
      !Number.isSafeInteger(value.verifiedRevision) ||
      value.revision! < 0 ||
      value.verifiedRevision! < 0 ||
      value.verifiedRevision! > value.revision! ||
      !Number.isSafeInteger(value.requestStartRevision) ||
      value.requestStartRevision! < 0 ||
      value.requestStartRevision! > value.revision! ||
      typeof value.completionNotified !== "boolean"
    )
      return;
    this.revision = value.revision!;
    this.verifiedRevision = value.verifiedRevision!;
    this.requestStartRevision = value.requestStartRevision!;
    this.completionNotified = value.completionNotified;
    this.pending.clear();
    this.failures.clear();
  }
}
