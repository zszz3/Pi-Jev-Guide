import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { createJudge } from "../src/judge.ts";
import { readConfig } from "../src/config.ts";
import { emptyFrame, updateFrame } from "../src/frame.ts";
const key=process.env.TYPESAFE_API_KEY?.trim() || execFileSync("security",["find-generic-password","-s","jevctl","-a","typesafe-api-key","-w"],{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim();
const judge=createJudge(readConfig({TYPESAFE_API_KEY:key,JEV_GUARD_TIMEOUT_MS:"10000"}));
let frame=await updateFrame(emptyFrame(),"给 Pi-Jev-Guide 增加运行时检查功能，修改代码并验证。",undefined,[key]);
const results=[];
for(const [text,expected] of [
  ["不要新增任何依赖。","constraint"],
  ["不对，不要做桌面界面，我要在 Pi 终端里使用。","correction"],
  ["接下来给刚才的运行时检查补上测试。","subgoal"],
  ["好的，继续。","none"],
  ["现在进度怎么样？","none"],
  ["插件先放一边，换个任务，帮我写一篇介绍 Three.js 的博客。","new_task"],
]) {
  const start=performance.now();
  frame=await updateFrame(frame,text,judge,[key]);
  const result={text,expected,actual:frame.lastChange,pass:frame.lastChange===expected,ms:Math.round(performance.now()-start),probabilities:frame.probabilities,goal:frame.goal,subgoal:frame.subgoal,constraints:frame.constraints,pending:frame.pending};
  results.push(result);console.log(JSON.stringify(result));
}
writeFileSync(new URL("./live-frame-results.json",import.meta.url),JSON.stringify({timestamp:new Date().toISOString(),timeoutMs:10000,note:"Sequential synthetic Chinese dialogue; live Jev, no commands executed. Runtime input checks use the configured timeout (default 2500ms).",results},null,2)+"\n");
if(results.some(r=>!r.pass))process.exitCode=1;
