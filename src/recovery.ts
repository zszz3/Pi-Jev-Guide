import type { Judge } from "./judge.ts";
import { bounded, redact } from "./redact.ts";

export interface RecoverySettings {
  enabled: boolean;
  graceMs: number;
  cooldownMs: number;
  maxConsecutive: number;
}
export const defaultRecovery = (): RecoverySettings => ({
  enabled: false, graceMs: 3000, cooldownMs: 20000, maxConsecutive: 3,
});
export interface RecoveryCandidate {
  stopReason: string;
  error: string;
  task: string;
  lastText: string;
  lastTool?: { name: string; status: "pending" | "done" | "failed" };
}
export function recoverable(candidate: RecoveryCandidate): boolean {
  if (candidate.stopReason === "aborted") return false;
  if (candidate.stopReason === "length") return true;
  if (candidate.stopReason !== "error") return false;
  // A 429 with exhausted quota must never be treated as transient rate limiting.
  if (/401|403|auth|credential|api.?key|quota|balance|billing|credit|payment|model.{0,20}(?:unknown|not found|not exist)|context.{0,25}(?:length|window|limit|overflow)|permission|policy|denied|unauthorized|额度|余额|鉴权|权限/i.test(candidate.error)) return false;
  return /429|5\d\d|timeout|timed out|network|fetch failed|connection|econn|socket|overload|rate.?limit|temporar|服务繁忙|网络|超时/i.test(candidate.error);
}
interface Hooks {
  settings(): RecoverySettings;
  judge(): Judge | undefined;
  allowed(): boolean;
  idle(): boolean;
  pending(): boolean;
  secrets(): readonly string[];
  send(text: string): void;
  notice(text: string): void;
  persist(attempts: number): void;
}
/** One settled run owns at most one timer. Cancellation invalidates in-flight judgments. */
export class Recovery {
  attempts = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private generation = 0;
  private active = false;
  constructor(private hooks: Hooks) {}
  cancel() {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    this.controller = undefined;
    this.active = false;
  }
  reset() { this.cancel(); this.attempts = 0; this.hooks.persist(0); }
  restore(attempts: number) {
    this.cancel();
    this.attempts = Number.isInteger(attempts) && attempts >= 0 ? attempts : 0;
  }
  get scheduled() { return this.active; }
  schedule(candidate: RecoveryCandidate) {
    const settings = this.hooks.settings();
    if (this.active || !settings.enabled || !this.hooks.allowed() || !recoverable(candidate)) return;
    if (!this.hooks.judge() || !this.hooks.idle() || this.hooks.pending()) return;
    if (this.attempts >= settings.maxConsecutive) {
      this.hooks.notice("自动续跑已达到次数上限，请检查错误后手动继续。");
      return;
    }
    const delay = this.attempts === 0 ? settings.graceMs : Math.max(settings.graceMs, Math.min(300000, settings.cooldownMs * 2 ** (this.attempts - 1)));
    const generation = this.generation;
    this.active = true;
    this.hooks.notice(`异常停止：将在 ${Math.ceil(delay / 1000)} 秒后检查是否续跑；/jevguard recovery pause 可取消。`);
    this.timer = setTimeout(() => { void this.run(candidate, generation); }, delay);
  }
  private async run(candidate: RecoveryCandidate, generation: number) {
    this.timer = undefined;
    const valid = () => generation === this.generation && this.hooks.settings().enabled && this.hooks.allowed() && this.hooks.idle() && !this.hooks.pending();
    const judge = this.hooks.judge();
    try {
      if (!valid() || !judge) return;
      const controller = new AbortController();
      this.controller = controller;
      const state = redact(JSON.stringify({ ...candidate, task: bounded(candidate.task, 3000), error: bounded(candidate.error, 1500), lastText: bounded(candidate.lastText, 3000) }), this.hooks.secrets());
      const scores = await judge.evaluate(state, {
        can_continue: "Does `task` describe requested work that is still unfinished in `lastText`? The caller has already established a technical interruption. Answer yes when the existing request has an identifiable unfinished step, such as running requested tests; answer no when completion is stated or the remaining step cannot be identified.",
        needs_user: "Do `task`, `lastText`, or `error` indicate that the agent must wait for the user to provide information, credentials, approval, or a decision before resuming? A transient service error alone does not require user input. Do not assume unmentioned approval requirements.",
      }, controller.signal);
      if (!valid()) return;
      if (!(scores.can_continue >= 0.9 && scores.needs_user <= 0.2)) {
        this.hooks.notice("Jev 未确认可安全续跑，保持停止，等待用户处理。");
        return;
      }
      this.attempts++;
      // Persist before sending; a reload or send failure must not reset the budget.
      this.hooks.persist(this.attempts);
      const tool = candidate.lastTool;
      const guard = tool?.status === "pending"
        ? "上次工具结果未确认。先核对实际状态，不要直接重复执行可能产生副作用的操作。"
        : tool?.status === "done" ? "上次工具已经完成，不要重复执行，基于已有结果继续。"
        : "先检查已有结果和实际状态，再决定下一步；不要盲目重复有副作用的操作。";
      this.hooks.send(`[Jev Guard 自动续跑 ${this.attempts}/${this.hooks.settings().maxConsecutive}] 上次因技术原因中断，请继续用户已授权的任务。${candidate.stopReason === "length" ? "输出达到上限，请接着未完成内容继续，避免重复。" : ""}${guard} 不扩大任务范围、不绕过审批；需要用户信息时明确询问并停止。`);
      this.hooks.notice(`已触发自动续跑 ${this.attempts}/${this.hooks.settings().maxConsecutive}。`);
    } catch {
      if (generation === this.generation) this.hooks.notice("自动续跑检查或发送失败，保持停止，请手动处理。");
    } finally {
      if (generation === this.generation) { this.active = false; this.controller = undefined; }
    }
  }
}
