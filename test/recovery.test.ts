import assert from "node:assert/strict";
import test from "node:test";
import { Recovery, recoverable, defaultRecovery, type RecoveryCandidate } from "../src/recovery.ts";
import { parseSettings } from "../src/settings.ts";
const candidate: RecoveryCandidate = { stopReason:"error",error:"503 Service unavailable",task:"Run the tests",lastText:"",lastTool:{name:"bash",status:"pending"} };
const flush = async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function setup() {
  const settings={...defaultRecovery(),enabled:true,graceMs:1000,cooldownMs:2000,maxConsecutive:2};
  const state={idle:true,pending:false,allowed:true};
  const sends:string[]=[], notices:string[]=[], saves:number[]=[];
  let evaluations=0;
  let evaluate=async()=>({can_continue:0.99,needs_user:0.01});
  const r=new Recovery({settings:()=>settings,judge:()=>({evaluate:async()=>{evaluations++;return evaluate();}}),allowed:()=>state.allowed,idle:()=>state.idle,pending:()=>state.pending,secrets:()=>[],send:text=>{sends.push(text);},notice:text=>{notices.push(text);},persist:n=>{saves.push(n);}});
  return {r,settings,state,sends,notices,saves,evaluations:()=>evaluations,setEvaluate:(fn:typeof evaluate)=>{evaluate=fn;}};
}
test("only recognized temporary errors and output limits can recover",()=>{
  for(const error of ["401 unauthorized","403 permission denied","429 quota exhausted","insufficient credits","unknown model","context length exceeded","policy blocked"])
    assert.equal(recoverable({...candidate,error}),false,error);
  for(const error of ["fetch failed","connection reset","429 rate limit","503 overloaded","request timed out"])
    assert.equal(recoverable({...candidate,error}),true,error);
  assert.equal(recoverable({...candidate,error:"Something unknown happened"}),false);
  for(const stopReason of ["stop","aborted","toolUse","deferred"])assert.equal(recoverable({...candidate,stopReason}),false);
  assert.equal(recoverable({...candidate,stopReason:"length"}),true);
});
test("settings default off, bounded and compatible with old files",()=>{
  assert.equal(parseSettings({version:1}).recovery.enabled,false);
  for(const recovery of [{enabled:"yes"},{maxConsecutive:0},{maxConsecutive:6},{graceMs:0},{cooldownMs:Infinity},{typo:true}])assert.throws(()=>parseSettings({version:1,recovery}));
});
test("deduplicates, uses backoff, preserves pending-tool warning and enforces cap",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const h=setup();t.after(()=>h.r.cancel());
  h.r.schedule(candidate);h.r.schedule(candidate);
  t.mock.timers.tick(999);await flush();assert.equal(h.sends.length,0);
  t.mock.timers.tick(1);await flush();assert.equal(h.sends.length,1);
  assert.match(h.sends[0],/先核对实际状态/);assert.deepEqual(h.saves,[1]);
  h.r.schedule(candidate);t.mock.timers.tick(1999);await flush();assert.equal(h.sends.length,1);
  t.mock.timers.tick(1);await flush();assert.equal(h.sends.length,2);
  h.r.schedule(candidate);t.mock.timers.tick(10000);await flush();assert.equal(h.sends.length,2);
  h.r.restore(2);h.r.schedule(candidate);assert.equal(h.r.scheduled,false);
  h.r.reset();assert.equal(h.r.attempts,0);
});
test("pause, queued input, host recovery and policy denial cancel sends",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  for(const change of [(h:ReturnType<typeof setup>)=>{h.settings.enabled=false;},(h:ReturnType<typeof setup>)=>{h.state.pending=true;},(h:ReturnType<typeof setup>)=>{h.state.idle=false;},(h:ReturnType<typeof setup>)=>{h.state.allowed=false;},(h:ReturnType<typeof setup>)=>h.r.cancel()]){
    const h=setup();h.r.schedule(candidate);change(h);t.mock.timers.tick(1000);await flush();assert.equal(h.sends.length,0);h.r.cancel();
  }
});
test("stale in-flight answer and failed or uncertain Jev never continue",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const h=setup();
  let resolve!:(x:{can_continue:number;needs_user:number})=>void;
  h.setEvaluate(()=>new Promise(r=>{resolve=r;}));
  h.r.schedule(candidate);t.mock.timers.tick(1000);await flush();h.r.cancel();resolve({can_continue:1,needs_user:0});await flush();assert.equal(h.sends.length,0);
  for(const fn of [async()=>({can_continue:0.5,needs_user:0}),async()=>({can_continue:1,needs_user:0.8}),async()=>{throw new Error("offline");}]){
    h.setEvaluate(fn);h.r.schedule(candidate);t.mock.timers.tick(1000);await flush();assert.equal(h.sends.length,0);
  }
  h.r.cancel();
});
