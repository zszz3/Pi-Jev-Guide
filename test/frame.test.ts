import test from "node:test";
import assert from "node:assert/strict";
import { emptyFrame, updateFrame, selectChange, restoreFrame, frameContext } from "../src/frame.ts";
import { createJudge, type Judge } from "../src/judge.ts";
import { readConfig } from "../src/config.ts";
const answer=(kind:string)=>({choice:kind,probabilities:Object.fromEntries(["new_task","constraint","correction","subgoal","none"].map(k=>[k,k===kind?1:0]))});
const judge=(kind:string):Judge=>({evaluate:async()=>({}),choose:async()=>answer(kind)});
test("task frame preserves the goal, verbatim constraints and correction provenance",async()=>{
  let f=await updateFrame(emptyFrame(),"Build a Pi plugin");
  f=await updateFrame(f,"不要新增依赖",judge("constraint"));
  assert.deepEqual(f.constraints,[{text:"不要新增依赖",turn:2,kind:"constraint"}]);
  f=await updateFrame(f,"不对，只改运行时检查",judge("correction"));
  f=await updateFrame(f,"接下来补测试",judge("subgoal"));
  f=await updateFrame(f,"好的，继续",judge("none"));
  assert.equal(f.goal,"Build a Pi plugin");assert.equal(f.subgoal,"接下来补测试");assert.equal(f.constraints.length,2);
  assert.equal(restoreFrame(JSON.parse(JSON.stringify(f)))?.goal,f.goal);
  f=await updateFrame(f,"换个任务，写博客",judge("new_task"));
  assert.equal(f.goal,"换个任务，写博客");assert.equal(f.constraints.length,2,"classification alone cannot revoke earlier restrictions");
});
test("pooled constraints/corrections and unclear outcomes do not silently erase goals",async()=>{
  assert.equal(selectChange({choice:"correction",probabilities:{new_task:0.05,constraint:0.35,correction:0.4,subgoal:0.1,none:0.1}}),"correction");
  const f=await updateFrame(await updateFrame(emptyFrame(),"Original task"),"Ambiguous follow-up",{evaluate:async()=>({}),choose:async()=>({choice:"new_task",probabilities:{new_task:0.4,constraint:0.1,correction:0.1,subgoal:0.3,none:0.1}})});
  assert.equal(f.goal,"Original task");assert.equal(f.pending,"Ambiguous follow-up");
});
test("failure retains new input, cancels stale work and redacts before classification",async()=>{
  const first=await updateFrame(emptyFrame(),"Original task");
  const unavailable=await updateFrame(first,"Do not deploy");
  assert.equal(unavailable.pending,"Do not deploy");assert.equal(unavailable.goal,first.goal);
  let sent="";
  const f=await updateFrame(first,"Use secret-value-123",{evaluate:async()=>({}),choose:async state=>{sent=state;return answer("constraint");}},["secret-value-123"]);
  assert.ok(!sent.includes("secret-value-123"));assert.ok(!frameContext(f).includes("secret-value-123"));
  const controller=new AbortController();controller.abort();
  await assert.rejects(updateFrame(first,"new",judge("new_task"),[],controller.signal));
});
test("official SDK choice uses typed schema and rejects incomplete distributions",async()=>{
  let body:any;
  const j=createJudge(readConfig({TYPESAFE_API_KEY:"synthetic"}),async(_url,init)=>{
    body=JSON.parse(String(init?.body));
    return new Response(JSON.stringify({model:"fixture",answers:{classification:{type:"choice",choice:"a",probabilities:{a:0.9,b:0.1},confidence:0.8}}}),{status:200,headers:{"Content-Type":"application/json"}});
  })!;
  assert.equal((await j.choose!("state","pick",{a:"A",b:"B"})).choice,"a");
  assert.equal(body.questions.classification.type,"choice");
  await assert.rejects(j.choose!("state","pick",{a:"A",b:"B",c:"C"}));
});
