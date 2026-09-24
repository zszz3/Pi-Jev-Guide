import type { Judge, ChoiceResult } from "./judge.ts";
import { bounded, redact } from "./redact.ts";
export const frameCriteria = {
  new_task: "Starts a different task or replaces the overall goal, not merely the next step of the same task",
  constraint: "Adds a requirement or restriction on how to do the current task",
  correction: "Corrects the current approach or rejects an earlier interpretation",
  subgoal: "Moves to a concrete next step within the existing overall task",
  none: "Acknowledges, asks about status, or says to continue without changing the task",
};
export type FrameChange = keyof typeof frameCriteria | "unclear" | "unavailable";
export interface TaskFrame {
  version: 1;
  goal: string;
  subgoal: string;
  constraints: Array<{ text: string; turn: number; kind: "constraint" | "correction" }>;
  recent: Array<{ role: "user" | "assistant"; text: string }>;
  turn: number;
  pending: string;
  lastChange: FrameChange;
  probabilities?: Record<string, number>;
}
export const emptyFrame = (): TaskFrame => ({version:1,goal:"",subgoal:"",constraints:[],recent:[],turn:0,pending:"",lastChange:"none"});
export function selectChange(result: ChoiceResult): FrameChange {
  const p=result.probabilities;
  if (Object.keys(frameCriteria).some(k=>!Number.isFinite(p[k]) || p[k]<0 || p[k]>1)) return "unavailable";
  const limiting=p.constraint+p.correction;
  const entries: Array<[keyof typeof frameCriteria,number]> = [["new_task",p.new_task],[p.correction>p.constraint?"correction":"constraint",limiting],["subgoal",p.subgoal],["none",p.none]];
  entries.sort((a,b)=>b[1]-a[1]);
  return entries[0][1]>=0.6 ? entries[0][0] : "unclear";
}
export async function updateFrame(frame: TaskFrame, raw: string, judge?: Judge, secrets: readonly string[]=[], signal?: AbortSignal): Promise<TaskFrame> {
  const text=redact(raw,secrets);
  const next: TaskFrame=structuredClone(frame);
  next.turn++;
  delete next.probabilities;
  let change: FrameChange="new_task";
  if (frame.goal) {
    change="unavailable";
    const state=JSON.stringify({user_message:text,task_frame:{goal:frame.goal,subgoal:frame.subgoal,constraints:frame.constraints,pending:frame.pending},recent_turns:frame.recent});
    if (judge?.choose && state.length<=16000) {
      try {
        const result=await judge.choose(state,"What does user_message change about the existing task_frame? Use recent_turns to resolve short replies. Choose one category.",frameCriteria,signal);
        change=selectChange(result);next.probabilities=result.probabilities;
      } catch { signal?.throwIfAborted(); }
    }
  }
  signal?.throwIfAborted();
  if (text.length>6000 || next.constraints.length>=32) change="unclear";
  if (change==="new_task") { next.goal=text;next.subgoal="";next.pending=""; }
  else if(change==="constraint" || change==="correction") {
    next.constraints.push({text,turn:next.turn,kind:change});
    // Corrections are retained verbatim; we never infer which older constraint to delete.
  } else if(change==="subgoal") next.subgoal=text;
  if(change==="unclear" || change==="unavailable") next.pending=bounded(text,6000);
  next.lastChange=change;
  next.recent=[...next.recent,{role:"user" as const,text:bounded(text,1200)}].slice(-6);
  return next;
}
export function frameContext(frame: TaskFrame): string {
  return JSON.stringify({goal:frame.goal,current_subgoal:frame.subgoal,user_constraints:frame.constraints,unclassified_user_message:frame.pending});
}
export function restoreFrame(value: unknown): TaskFrame | undefined {
  if (!value || typeof value!=="object") return;
  const f=value as TaskFrame;
  if(f.version!==1 || typeof f.goal!=="string" || typeof f.subgoal!=="string" || typeof f.pending!=="string" || !Number.isInteger(f.turn) || !Array.isArray(f.constraints) || !Array.isArray(f.recent))return;
  if(f.constraints.some(c=>!c || typeof c.text!=="string" || !Number.isInteger(c.turn) || !["constraint","correction"].includes(c.kind)))return;
  if(f.recent.some(r=>!r || !["user","assistant"].includes(r.role) || typeof r.text!=="string"))return;
  return structuredClone(f);
}
