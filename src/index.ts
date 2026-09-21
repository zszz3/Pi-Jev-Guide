import { Recovery, type RecoveryCandidate } from "./recovery.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readConfig, type Config } from "./config.ts";
import { createJudge, type Judge } from "./judge.ts";
import { decide, type Action, type Decision } from "./policy.ts";
import { bounded, redact, redactValue } from "./redact.ts";
import { readRules } from "./rules.ts";
import { Tracker } from "./tracker.ts";
import {
  readApiKey,
  saveApiKey,
  deleteApiKey,
  validateApiKey,
  promptApiKey,
} from "./auth.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import {
  builtinGuards,
  capabilities,
  stages,
  defaultSettings,
  loadSettings,
  parseSettings,
  saveSettings,
  type BuiltinId,
  type Settings,
  type Stage,
} from "./settings.ts";
import { evaluateRules, matches, type Finding, type GuardEvent } from "./engine.ts";

const stateType = "jev-guard-state-v1";
const messageType = "jev-guard";

/** Factory seam keeps the Pi adapter testable without live API calls. */
export function installGuard(
  pi: ExtensionAPI,
  config: Config,
  judge = createJudge(config),
  options: {
    settings?: Settings;
    settingsPath?: string;
    authPath?: string;
    judgeFactory?: (config: Config) => Judge | undefined;
  } = {},
): void {
  const environmentKey = config.apiKey;
  const judgeFactory = options.judgeFactory ?? createJudge;
  let authError = false;
  let authBusy = false;
  let keySource = environmentKey ? "环境变量" : "未配置";
  if (options.authPath) {
    try {
      const saved = readApiKey(options.authPath);
      if (saved) {
        const savedJudge = judgeFactory({ ...config, apiKey: saved });
        config.apiKey = saved;
        judge = savedJudge;
        keySource = "本地保存";
      }
    } catch {
      authError = true;
    }
  }
  let settings = options.settings ?? defaultSettings();
  let settingsError = false;
  if (options.settingsPath) {
    try {
      settings = loadSettings(options.settingsPath);
    } catch {
      settingsError = true;
    }
  }
  const enabled = (id: BuiltinId) => settings.builtins[id];
  let tracker = new Tracker();
  let task = "";
  let loadedRules: string[] = [];
  let coaching = 0;
  let outputErrorNotified = false;
  let epoch = 0;
  let lifetime = new AbortController();
  const knownSecrets = [
    ...config.knownSecrets,
    ...(environmentKey ? [environmentKey] : []),
    ...(config.apiKey ? [config.apiKey] : []),
  ];
  config.knownSecrets = knownSecrets;
  const trace: string[] = [];
  let checks = 0;
  let blocks = 0;
  let masks = 0;
  const progressChecks = new Map<string, { at: number; count: number }>();
  let runtimeBusy = false;
  const runtimeNotices = new Set<string>();

  const save = () => pi.appendEntry(stateType, tracker.snapshot());
  const status = (ctx: ExtensionContext, last = "就绪") => {
    if (ctx.hasUI)
      ctx.ui.setStatus(
        "jev-guard",
        `Jev · ${config.mode} · ${judge ? "在线检查" : "仅本地规则"} · ${last}`,
      );
  };
  const record = (ctx: ExtensionContext, text: string) => {
    trace.push(redact(text, knownSecrets));
    if (trace.length > 20) trace.shift();
    status(ctx, text);
  };
  const coach = (text: string) => {
    if (coaching >= 4) return;
    coaching++;
    pi.sendMessage(
      {
        customType: messageType,
        content: redact(text, knownSecrets),
        display: true,
      },
      { deliverAs: "steer" },
    );
  };
  const report = (ctx: ExtensionContext, text: string) => {
    const safe = redact(text, knownSecrets);
    if (ctx.hasUI) ctx.ui.notify(safe, "info");
    else
      pi.sendMessage({ customType: messageType, content: safe, display: true });
  };
  let recoveryContext: ExtensionContext | undefined;
  let recoveryCandidate: RecoveryCandidate | undefined;
  let recoveryBlocked = false;
  let recoveryPrompt: string | undefined;
  let lastRecoveryTool: RecoveryCandidate["lastTool"];
  const recovery = new Recovery({
    settings: () => settings.recovery,
    // Recovery runs while idle, so allow a longer bounded check than tool interception.
    judge: () => !judge ? undefined : config.apiKey
      ? judgeFactory({ ...config, timeoutMs: Math.max(config.timeoutMs, 10000) })
      : judge,
    allowed: () => !settingsError && !recoveryBlocked && config.mode === "guard" && !lifetime.signal.aborted && !recoveryContext?.signal?.aborted,
    idle: () => recoveryContext?.isIdle() ?? false,
    pending: () => recoveryContext?.hasPendingMessages() ?? true,
    secrets: () => knownSecrets,
    send: (text) => { recoveryPrompt = text; pi.sendUserMessage(text, { deliverAs: "followUp" }); },
    notice: (text) => { if (recoveryContext) report(recoveryContext, text); },
    persist: (attempts) => pi.appendEntry("jev-guard-recovery-v1", { attempts }),
  });
  const custom = (event: GuardEvent, signal?: AbortSignal) =>
    evaluateRules(settings.rules, event, judge, knownSecrets, signal);
  const applyFindings = async (
    findings: Finding[],
    ctx: ExtensionContext,
    preview: string,
    signal: AbortSignal,
    currentEpoch: number,
  ): Promise<boolean> => {
    for (const finding of findings)
      record(
        ctx,
        `${finding.id}: ${finding.action}${finding.unavailable ? " (unavailable)" : ""}`,
      );
    if (config.mode === "observe") {
      if (findings.length)
        report(
          ctx,
          `[仅观察，未阻止] ${findings.map((f) => f.message).join("\n")}`,
        );
      return signal.aborted || epoch !== currentEpoch;
    }
    if (findings.some((f) => f.action === "block")) return true;
    const confirmations = findings.filter((f) => f.action === "confirm");
    if (
      confirmations.length &&
      (!ctx.hasUI ||
        !(await ctx.ui.confirm(
          "Jev Guard · 自定义规则确认",
          redact(
            confirmations.map((f) => f.message).join("\n") +
              "\n\n" +
              bounded(preview, 1000),
            knownSecrets,
          ),
        )))
    )
      return true;
    if (signal.aborted || epoch !== currentEpoch) return true;
    for (const f of findings.filter((f) => f.action === "warn"))
      coach(`Jev Guard · ${f.id}: ${f.message}`);
    return false;
  };
  const restore = (ctx: ExtensionContext) => {
    recovery.cancel();
    recoveryCandidate = undefined;
    recoveryPrompt = undefined;
    lastRecoveryTool = undefined;
    recoveryBlocked = false;
    recoveryContext = ctx;
    recovery.restore(0);
    epoch++;
    lifetime.abort();
    lifetime = new AbortController();
    tracker = new Tracker();
    task = "";
    loadedRules = [];
    coaching = 0;
    outputErrorNotified = false;
    checks = blocks = masks = 0;
    trace.length = 0;
    progressChecks.clear();
    runtimeNotices.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "jev-guard-recovery-v1")
        recovery.restore((entry.data as { attempts?: number })?.attempts ?? 0);
      if (entry.type === "custom" && entry.customType === stateType)
        tracker.restore(entry.data);
      if (entry.type === "message" && entry.message.role === "user") {
        const content = entry.message.content;
        const restoredTask =
          typeof content === "string"
            ? content
            : content
                .filter((item) => item.type === "text")
                .map((item) => item.text)
                .join("\n");
        if (!restoredTask.startsWith("[Jev Guard 自动续跑 ")) task = restoredTask;
      }
    }
    status(ctx);
  };
  pi.on("session_start", (_event, ctx) => {
    restore(ctx);
    if (authError)
      report(
        ctx,
        "保存的 API key 无法读取，请用 /jevguard login 重新配置；当前使用环境变量或本地检查。",
      );
    if (settingsError)
      report(
        ctx,
        "Jev Guard 配置无效，输入与工具调用暂时拦截。请用 /jevguard config 修正，或修复文件后 /jevguard reload。",
      );
    if (ctx.hasUI)
      ctx.ui.notify(
        judge
          ? "Jev Guard 已启用：动作及输出检查会将脱敏后的任务、参数和规则发送到 TypeSafe。/jevguard status 查看状态。"
          : "Jev Guard 仅运行本地规则；运行 /jevguard login 配置 API key 后立即启用 Jev。",
        "info",
      );
  });
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_before_switch", () => { recovery.cancel(); recoveryCandidate = undefined; });
  pi.on("session_before_fork", () => { recovery.cancel(); recoveryCandidate = undefined; });
  pi.on("session_before_tree", () => { recovery.cancel(); recoveryCandidate = undefined; });
  pi.on("session_shutdown", () => {
    recovery.cancel(); recoveryCandidate = undefined;
    epoch++;
    lifetime.abort();
  });
  pi.on("input", async (event, ctx) => {
    if (event.source !== "extension") { recovery.reset(); recoveryCandidate = undefined; recoveryPrompt = undefined; }

    if (settingsError) {
      report(ctx, "Jev Guard 配置无效；请先 /jevguard config。");
      return { action: "handled" };
    }
    try {
      const currentEpoch = epoch;
      const signal = AbortSignal.any(
        ctx.signal ? [ctx.signal, lifetime.signal] : [lifetime.signal],
      );
      const findings = await custom(
        { when: "input", cwd: ctx.cwd, task: event.text, text: event.text },
        signal,
      );
      if (
        await applyFindings(findings, ctx, event.text, signal, currentEpoch)
      ) {
        report(
          ctx,
          "此次输入未交给 Agent。" + findings.map((f) => f.message).join("\n"),
        );
        return { action: "handled" };
      }
    } catch {
      report(ctx, "输入检查未完成，此次输入未交给 Agent。");
      return { action: "handled" };
    }
    if (event.source !== "extension") {
      task = event.text;
      tracker.newRequest();
      coaching = 0;
      outputErrorNotified = false;
      save();
    }
  });
  pi.on("before_agent_start", (event) => {
    if (event.prompt !== recoveryPrompt) task = event.prompt;
    recoveryPrompt = undefined;
    loadedRules = (event.systemPromptOptions.contextFiles ?? []).map(
      (file) => file.path,
    );
  });

  // Notification events cannot veto an action. Never turn a runtime warning into
  // a steering message: doing so at agent_end can accidentally start another run.
  const runtimeCheck = async (event: GuardEvent, ctx: ExtensionContext, callId?: string) => {
    if (settingsError || runtimeBusy || !settings.rules.some((rule) => matches(rule, event))) return;
    const currentEpoch = epoch;
    const signal = AbortSignal.any(ctx.signal ? [ctx.signal, lifetime.signal] : [lifetime.signal]);
    if (signal.aborted) return;
    if (event.when === "tool_execution_update" && callId) {
      const previous = progressChecks.get(callId);
      const now = Date.now();
      if (previous && (previous.count >= 3 || now - previous.at < 2000)) return;
      progressChecks.set(callId, { at: now, count: (previous?.count ?? 0) + 1 });
    }
    runtimeBusy = true;
    try {
      const findings = await custom(event, signal);
      if (signal.aborted || currentEpoch !== epoch) return;
      for (const finding of findings) {
        const id = `${event.when}:${callId ?? "run"}:${finding.id}`;
        if (runtimeNotices.has(id) || runtimeNotices.size >= 20) continue;
        runtimeNotices.add(id);
        record(ctx, `${finding.id}: warn${finding.unavailable ? " (unavailable)" : ""}`);
        report(ctx, `Jev Guard · ${event.when} · ${finding.id}: ${finding.message}`);
      }
    } catch {
      if (!signal.aborted && currentEpoch === epoch) record(ctx, `${event.when}: 运行时检查未完成`);
    } finally {
      runtimeBusy = false;
    }
  };
  const runtimeText = (value: unknown) => bounded(JSON.stringify(redactValue(value, knownSecrets)) ?? "", 8000);
  pi.on("agent_start", () => {
    recovery.cancel();
    recoveryCandidate = undefined;
    recoveryBlocked = false;
    lastRecoveryTool = undefined;
    progressChecks.clear();
    runtimeNotices.clear();
  });
  pi.on("turn_start", (event, ctx) => runtimeCheck({
    when: "turn_start", cwd: ctx.cwd, task, text: runtimeText({ turnIndex: event.turnIndex, task, verification: tracker.snapshot() }),
  }, ctx));
  pi.on("tool_execution_start", (event, ctx) => runtimeCheck({
    when: "tool_execution_start", cwd: ctx.cwd, task, tool: event.toolName, input: event.args, text: runtimeText(event.args),
  }, ctx, event.toolCallId));
  pi.on("tool_execution_update", (event, ctx) => runtimeCheck({
    when: "tool_execution_update", cwd: ctx.cwd, task, tool: event.toolName, input: event.args, text: runtimeText(event.partialResult),
  }, ctx, event.toolCallId));
  pi.on("tool_execution_end", async (event, ctx) => {
    try {
      await runtimeCheck({ when: "tool_execution_end", cwd: ctx.cwd, task, tool: event.toolName,
        text: runtimeText({ result: event.result, isError: event.isError }) }, ctx, event.toolCallId);
    } finally { progressChecks.delete(event.toolCallId); }
  });
  pi.on("agent_end", (event, ctx) => runtimeCheck({
    when: "agent_end", cwd: ctx.cwd, task, text: runtimeText({ messages: event.messages, verification: tracker.snapshot() }),
  }, ctx));

  pi.on("tool_execution_start", (event) => {
    lastRecoveryTool = { name: event.toolName, status: "pending" };
  });
  pi.on("tool_execution_end", (event) => {
    lastRecoveryTool = { name: event.toolName, status: event.isError ? "failed" : "done" };
  });
  pi.on("agent_end", (event, ctx) => {
    recoveryContext = ctx;
    const last = [...event.messages].reverse().find(message => message.role === "assistant");
    if (!last || last.role !== "assistant") { recoveryCandidate = undefined; return; }
    if (last.stopReason === "aborted") { recovery.cancel(); recoveryCandidate = undefined; return; }
    recoveryCandidate = { stopReason: last.stopReason, error: last.errorMessage ?? "", task,
      lastText: last.content.filter(part => part.type === "text").map(part => part.text).join("\n"),
      lastTool: lastRecoveryTool };
  });
  pi.on("agent_settled", (_event, ctx) => {
    recoveryContext = ctx;
    const candidate = recoveryCandidate;
    recoveryCandidate = undefined;
    if (candidate) recovery.schedule(candidate);
  });

  const denyRecovery = <T extends { block: true }>(verdict: T): T => {
    recoveryBlocked = true; recovery.cancel(); return verdict;
  };
  pi.on("tool_call", async (event, ctx) => {
    try {
      if (settingsError)
        return denyRecovery({ block: true, reason: "Jev Guard 配置无效，请先修复配置。" });
      const currentEpoch = epoch;
      const signal = AbortSignal.any(
        ctx.signal ? [ctx.signal, lifetime.signal] : [lifetime.signal],
      );
      const action: Action = {
        tool: event.toolName,
        input: event.input,
        cwd: ctx.cwd,
      };
      let decision: Decision;
      try {
        const rules =
          judge && enabled("semantic-action")
            ? await readRules(
                ctx.cwd,
                typeof action.input.path === "string"
                  ? action.input.path
                  : undefined,
                loadedRules,
              )
            : "";
        const recentRequests = ctx.sessionManager
          .getBranch()
          .flatMap((entry) => {
            if (entry.type !== "message" || entry.message.role !== "user")
              return [];
            const content = entry.message.content;
            return [
              typeof content === "string"
                ? content
                : content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("\n"),
            ];
          })
          .slice(-4);
        const requestContext = `Current request:\n${bounded(task, 2500)}\n\nRecent user requests:\n${recentRequests.map((text) => bounded(text, 800)).join("\n\n")}`;
        decision = await decide(
          action,
          requestContext,
          rules,
          config,
          enabled("semantic-action") ? judge : undefined,
          signal,
          enabled("local-risk"),
        );
      } catch {
        return denyRecovery({
          block: true,
          reason: "Jev Guard 检查已取消或未能完成；本次调用没有执行。",
        });
      }
      if (signal.aborted || currentEpoch !== epoch)
        return denyRecovery({ block: true, reason: "会话已切换或操作已取消。" });
      if (decision.kind !== "block") {
        const findings = await custom(
          {
            when: "tool_call",
            cwd: ctx.cwd,
            task,
            tool: event.toolName,
            input: event.input,
            text: JSON.stringify(event.input),
          },
          signal,
        );
        if (
          await applyFindings(
            findings,
            ctx,
            JSON.stringify(event.input),
            signal,
            currentEpoch,
          )
        ) {
          blocks++;
          return denyRecovery({
            block: true,
            reason: redact(
              `Jev Guard: ${findings.map((f) => f.message).join("\n") || "检查取消"}`,
              knownSecrets,
            ),
          });
        }
      }
      checks++;
      record(ctx, `${event.toolName}: ${decision.kind} (${decision.source})`);
      if (config.mode === "observe" && decision.kind !== "allow") {
        if (ctx.hasUI)
          ctx.ui.notify(`[仅观察，未阻止] ${decision.reason}`, "warning");
      } else if (decision.kind === "block") {
        blocks++;
        return denyRecovery({
          block: true,
          reason: `Jev Guard: ${decision.reason} 不要原样重试。`,
        });
      } else if (decision.kind === "confirm") {
        // Approval is bound to this call, never cached or inferred from model output.
        const preview = bounded(
          redact(JSON.stringify(action.input), knownSecrets),
          1000,
        );
        const accepted =
          ctx.hasUI &&
          (await ctx.ui.confirm(
            "Jev Guard · 确认此次操作",
            `${decision.reason}\n\n${event.toolName}\n${preview}`,
          ));
        if (!accepted || signal.aborted || currentEpoch !== epoch) {
          blocks++;
          return denyRecovery({
            block: true,
            reason:
              "Jev Guard: 此次操作未获确认。请采用其他方案，或说明需要用户采取的操作；不要原样重试。",
          });
        }
      } else if (decision.kind === "warn") {
        coach(`Jev Guard 提醒：${decision.reason}`);
      }
      tracker.begin(event.toolCallId, action);
      save();
    } catch {
      // Pi treats thrown hook errors as non-blocking; explicitly deny this call instead.
      return denyRecovery({
        block: true,
        reason: "Jev Guard 检查或确认流程异常，此次操作未执行。",
      });
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    try {
      const currentEpoch = epoch;
      const signal = AbortSignal.any(
        ctx.signal ? [ctx.signal, lifetime.signal] : [lifetime.signal],
      );
      const rawText = event.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      let content = event.content.map((part) =>
        part.type === "text" && enabled("redact-output")
          ? { ...part, text: redact(part.text, knownSecrets) }
          : part,
      );
      let details = enabled("redact-output")
        ? redactValue(event.details, knownSecrets)
        : event.details;
      const sanitizedText = content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (rawText !== sanitizedText) {
        masks++;
        record(ctx, "输出中的凭据样式已脱敏");
      }
      if (
        judge &&
        enabled("semantic-output") &&
        config.scanOutput &&
        sanitizedText &&
        !signal.aborted
      ) {
        try {
          const scores = await judge.evaluate(
            bounded(redact(sanitizedText, knownSecrets)),
            {
              credentials:
                "Does this tool output still expose actual passwords, private keys or authentication tokens, excluding redaction markers, placeholders, variable names and public identifiers?",
            },
            signal,
          );
          if (scores.credentials >= config.leakThreshold) {
            content = [
              {
                type: "text",
                text: "[Jev Guard 已隐藏疑似含凭据的工具输出及元数据。请让工具只返回必要字段，避免打印凭据。]",
              },
            ];
            details = { jevGuard: "withheld-sensitive-output" };
            masks++;
          }
        } catch {
          // Local redaction remains in place even when semantic scanning is unavailable.
          if (!signal.aborted && !outputErrorNotified && ctx.hasUI) {
            outputErrorNotified = true;
            ctx.ui.notify(
              "Jev 输出检查暂不可用；本地脱敏仍然生效。",
              "warning",
            );
          }
        }
      }
      const findings = await custom(
        {
          when: "tool_result",
          cwd: ctx.cwd,
          task,
          tool: event.toolName,
          input: event.input,
          text: sanitizedText,
        },
        signal,
      );
      if (currentEpoch !== epoch || signal.aborted)
        throw new Error("Stale output check");
      for (const finding of findings)
        record(ctx, `${finding.id}: ${finding.action}`);
      if (findings.some((f) => f.action === "hide")) {
        content = [
          {
            type: "text",
            text: "[Jev Guard 根据自定义规则隐藏了工具结果及元数据。]",
          },
        ];
        details = { jevGuard: "custom-rule-hidden" };
        masks++;
      }
      for (const finding of findings.filter((f) => f.action === "warn")) {
        if (config.mode === "guard")
          coach(`Jev Guard · ${finding.id}: ${finding.message}`);
        else report(ctx, finding.message);
      }
      if (currentEpoch === epoch) {
        const repeated = tracker.finish(
          event.toolCallId,
          { tool: event.toolName, input: event.input, cwd: ctx.cwd },
          event.isError,
          sanitizedText,
        );
        if (
          repeated &&
          enabled("repeated-failure") &&
          !signal.aborted &&
          config.mode === "guard"
        ) {
          coach(
            "Jev Guard：相同工具参数已产生三次相同失败。不要再次原样重试；先检查失败原因，再换方法、补充证据，或向用户说明阻塞。不要绕过权限或安全检查。",
          );
        }
        save();
      }
      return { content, details };
    } catch {
      // Never fall back to unredacted output if metadata, UI or persistence fails.
      return {
        content: [
          {
            type: "text",
            text: "[Jev Guard 输出处理失败，已隐藏此次输出。请缩小输出范围后重试。]",
          },
        ],
        details: { jevGuard: "redaction-failed" },
      };
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    const message = event.message;
    if (
      message.role !== "assistant" ||
      message.stopReason !== "stop" ||
      message.content.some((part) => part.type === "toolCall")
    )
      return;
    try {
      const currentEpoch = epoch;
      const signal = AbortSignal.any(
        ctx.signal ? [ctx.signal, lifetime.signal] : [lifetime.signal],
      );
      const findings = await custom(
        {
          when: "turn_end",
          cwd: ctx.cwd,
          task,
          text: message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
        },
        signal,
      );
      if (epoch === currentEpoch)
        await applyFindings(findings, ctx, "", signal, currentEpoch);
    } catch {
      if (!ctx.signal?.aborted) report(ctx, "本轮自定义收尾检查未完成。");
    }
    if (
      config.mode !== "guard" ||
      !enabled("completion-check") ||
      !tracker.needsVerification() ||
      ctx.signal?.aborted
    )
      return;
    tracker.completionNotified = true;
    save();
    coach(
      "Jev Guard 完成检查：本任务观察到了源码或配置写入，但在最近一次写入后没有观察到成功的验证命令。若适用，请执行与变更相关的测试、构建或检查；如果不适用、无法执行，或用户明确不要运行，请说明原因。不要声称未执行的验证已经通过。",
    );
  });

  pi.registerCommand("jevguard", {
    description:
      "Jev Guard: recovery on|pause|status | login | logout | add | rules | config | reload | enable/disable ID | status | trace | mode guard|observe",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (input.startsWith("recovery")) {
        const action = input.split(/\s+/)[1] ?? "status";
        recoveryContext = ctx;
        if (["on", "off", "pause", "resume"].includes(action)) {
          recovery.cancel();
          const next = parseSettings({ ...settings, recovery: { ...settings.recovery, enabled: action === "on" || action === "resume" } });
          try {
            if (options.settingsPath) saveSettings(options.settingsPath, next);
            settings = next;
          } catch { report(ctx, "自动续跑配置未保存，待执行的续跑已取消。"); return; }
        } else if (action !== "status") {
          report(ctx, "用法：/jevguard recovery on|off|pause|resume|status"); return;
        }
        report(ctx, `自动续跑：${settings.recovery.enabled ? "开启" : "关闭"}；已续跑 ${recovery.attempts}/${settings.recovery.maxConsecutive} 次；${recovery.scheduled ? "等待检查" : "无等待任务"}。仅恢复之后发生的技术中断，不追溯恢复旧任务。`);
        return;
      }

      if (/^(login|logout)(?:\s|$)/.test(input)) {
        if (input !== "login" && input !== "logout") {
          report(
            ctx,
            "请仅输入 /jevguard login 或 /jevguard logout，不要把 key 放在命令参数里。",
          );
          return;
        }
        if (!ctx.isIdle() || authBusy) {
          report(ctx, "请等待当前运行或配置操作结束。");
          return;
        }
        if (!options.authPath) {
          report(ctx, "当前未配置凭据文件位置。");
          return;
        }
        if (input === "login" && (!ctx.hasUI || ctx.mode !== "tui")) {
          report(
            ctx,
            "请在 Pi 交互终端运行 /jevguard login；无界面模式仍可使用 TYPESAFE_API_KEY。",
          );
          return;
        }
        recovery.cancel();
        authBusy = true;
        const currentEpoch = epoch;
        const signal = lifetime.signal;
        try {
          if (input === "logout") {
            const fallback = judgeFactory({
              ...config,
              apiKey: environmentKey,
            });
            deleteApiKey(options.authPath);
            config.apiKey = environmentKey;
            judge = fallback;
            keySource = environmentKey ? "环境变量" : "未配置";
            authError = false;
            status(ctx);
            report(
              ctx,
              environmentKey
                ? "已删除本地保存的 key；环境变量仍然生效。"
                : "已删除本地保存的 key，当前切换为本地检查；自定义语义规则按 onError 处理。",
            );
            return;
          }
          const entered = await promptApiKey(ctx);
          if (entered === undefined) return;
          const key = validateApiKey(entered);
          knownSecrets.push(key);
          if (signal.aborted || epoch !== currentEpoch) return;
          const candidate = judgeFactory({ ...config, apiKey: key });
          if (!candidate) throw new Error("No client");
          report(ctx, "正在验证 API key…");
          const result = await candidate.evaluate(
            "Connection test: 2 + 2 = 4.",
            { connection: "Is the arithmetic statement correct?" },
            signal,
          );
          if (
            !Number.isFinite(result.connection) ||
            result.connection < 0 ||
            result.connection > 1
          )
            throw new Error("Invalid response");
          if (signal.aborted || epoch !== currentEpoch) return;
          saveApiKey(options.authPath, key);
          config.apiKey = key;
          judge = candidate;
          keySource = "本地保存";
          authError = false;
          status(ctx);
          report(
            ctx,
            "API key 已验证并保存，Jev 已立即启用。检查会将脱敏后的任务、参数、规则及启用的输出检查内容发送到 TypeSafe。",
          );
        } catch {
          report(
            ctx,
            "API key 配置未完成（格式、网络、服务或文件读写失败），原配置保持不变。请检查后重试。",
          );
        } finally {
          authBusy = false;
        }
        return;
      }
      if (input === "rules") {
        report(
          ctx,
          [
            ...Object.entries(builtinGuards).map(
              ([id, guard]) =>
                `${id}: ${enabled(id as BuiltinId) ? "on" : "off"} · ${guard.when} · ${guard.description}`,
            ),
            ...settings.rules.map(
              (rule) =>
                `${rule.id}: ${rule.enabled ? "on" : "off"} · ${rule.when} → ${rule.action}${rule.question ? " · Jev" : " · local"}`,
            ),
          ].join("\n"),
        );
        return;
      }
      if (
        input === "add" ||
        input === "config" ||
        input === "reload" ||
        /^(enable|disable)\s/.test(input)
      ) {
        if (!ctx.isIdle()) {
          report(ctx, "请等待 Agent 当前运行结束后修改规则。");
          return;
        }
        try {
          if (!options.settingsPath)
            throw new Error("No persistent settings path configured");
          let next: Settings;
          if (input === "add") {
            if (settingsError)
              throw new Error("Fix invalid configuration first");
            if (!ctx.hasUI) {
              report(
                ctx,
                `请编辑 ${options.settingsPath} 后执行 /jevguard reload。`,
              );
              return;
            }
            const labels = [
              "input · 用户输入时",
              "tool_call · 工具执行前",
              "tool_result · 工具返回后",
              "turn_end · 本轮回答结束时",
              "turn_start · 每轮开始时",
              "tool_execution_start · 工具开始运行时",
              "tool_execution_update · 工具运行中的进度输出",
              "tool_execution_end · 工具运行结束时",
              "agent_end · 整次 Agent 运行结束时",
            ];
            const stageChoice = await ctx.ui.select("什么时候检查？", labels);
            if (!stageChoice) return;
            const when = stages[labels.indexOf(stageChoice)] as Stage;
            const id = await ctx.ui.input("规则 ID（小写字母、数字和连字符）");
            if (!id) return;
            const method = await ctx.ui.select("怎样判断？", [
              "本地文本包含",
              "Jev 语义判断",
            ]);
            if (!method) return;
            const condition = await ctx.ui.input(
              method === "本地文本包含"
                ? "包含什么文本时触发？（区分大小写）"
                : "交给 Jev 判断的问题（回答是时触发）",
            );
            if (!condition) return;
            const action = await ctx.ui.select(
              "命中后怎么办？warn=提醒，confirm=确认，block=拦截，hide=隐藏结果",
              [...capabilities[when]],
            );
            if (!action) return;
            const message = await ctx.ui.input("命中时显示的说明");
            if (!message) return;
            next = parseSettings({
              ...settings,
              rules: [
                ...settings.rules,
                {
                  id,
                  when,
                  action,
                  message,
                  ...(method === "本地文本包含"
                    ? { match: { contains: condition } }
                    : { question: condition }),
                },
              ],
            });
            saveSettings(options.settingsPath, next);
          } else if (input === "reload")
            next = loadSettings(options.settingsPath);
          else if (input === "config") {
            if (!ctx.hasUI) {
              report(
                ctx,
                `请编辑 ${options.settingsPath} 后执行 /jevguard reload。`,
              );
              return;
            }
            const edited = await ctx.ui.editor(
              "Jev Guard 规则配置 (JSON)",
              JSON.stringify(settings, null, 2),
            );
            if (edited === undefined) return;
            next = parseSettings(JSON.parse(edited));
            saveSettings(options.settingsPath, next);
          } else {
            if (settingsError)
              throw new Error("Fix invalid configuration first");
            next = structuredClone(settings);
            const [verb, id, extra] = input.split(/\s+/);
            if (extra || !id) throw new Error("Use enable/disable ID");
            if (Object.hasOwn(builtinGuards, id))
              next.builtins[id as BuiltinId] = verb === "enable";
            else {
              const rule = next.rules.find((rule) => rule.id === id);
              if (!rule) throw new Error("Unknown rule id");
              rule.enabled = verb === "enable";
            }
            saveSettings(options.settingsPath, next);
          }
          recovery.cancel();
          settings = next;
          settingsError = false;
          report(ctx, `规则已生效：${options.settingsPath}`);
        } catch (error) {
          report(
            ctx,
            `配置未应用，保留原状态：${error instanceof Error && !(error instanceof SyntaxError) ? error.message : "JSON 格式无效"}`,
          );
        }
        return;
      }
      if (input === "mode guard" || input === "mode observe") {
        recovery.cancel();
        config.mode = input === "mode guard" ? "guard" : "observe";
        status(ctx);
        ctx.ui.notify(
          config.mode === "observe"
            ? "仅观察：风险动作不会被拦截；输出脱敏仍启用。此设置仅在本进程生效。"
            : "已启用动作拦截与提醒。",
          "info",
        );
      } else if (input === "trace") {
        ctx.ui.notify(trace.join("\n") || "暂无检查记录。", "info");
      } else if (!input || input === "status") {
        ctx.ui.notify(
          `模式：${config.mode}\nJev：${judge ? config.model : "未配置，仅本地规则"}\nAPI key：${keySource}${authError ? "（保存文件读取失败）" : ""}\n配置：${settingsError ? "无效（暂停输入与动作）" : (options.settingsPath ?? "内存")}\n启用自带检查：${Object.values(settings.builtins).filter(Boolean).length}/6，自定义规则：${settings.rules.filter((r) => r.enabled).length}\n本次加载后检查 ${checks} 次，拦截 ${blocks} 次，脱敏/隐藏 ${masks} 次\n未验证写入：${tracker.revision > tracker.verifiedRevision ? "有" : "无已观察记录"}\n输出语义检查：${judge && config.scanOutput && enabled("semantic-output") ? "开启" : "关闭"}`,
          "info",
        );
      } else
        ctx.ui.notify(
          "用法：/jevguard login | logout | add | rules | config | reload | enable/disable ID | status | trace | mode guard|observe",
          "warning",
        );
    },
  });
}

export default function jevGuard(pi: ExtensionAPI): void {
  const settingsPath = process.env.JEV_GUARD_CONFIG
    ? resolve(process.env.JEV_GUARD_CONFIG)
    : join(getAgentDir(), "jev-guard.json");
  installGuard(pi, readConfig(), undefined, {
    settingsPath,
    authPath: join(getAgentDir(), "jev-guard", "auth.json"),
  });
}
