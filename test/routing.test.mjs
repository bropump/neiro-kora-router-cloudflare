import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.ts";
import { selectOperator } from "../src/selection.ts";
import {
  database,
  fixture,
  insert,
  mint,
  payer,
  cacheFixture,
  context,
} from "./helpers.mjs";

test("fastest and cheapest use independent comparable measurements; payer pin wins", async () => {
  const now = Date.now(),
    a = await fixture({ NEIRO_MINT: mint }, now),
    b = { ...a, id: "other", payer: "other-payer" };
  for (const [row, ms, fee] of [
    [a, 10, 100],
    [b, 20, 50],
  ]) {
    row.sampleStats = {
      ok: true,
      at: now,
      region: "CDG",
      template: "same",
      mint,
      samples: 1,
      ewmaMs: ms,
    };
    row.sampleQuote = { ...row.sampleStats, feeInToken: fee };
  }
  assert.equal(
    selectOperator([a, b], { mode: "fastest", region: "CDG", now }).id,
    a.id,
  );
  assert.equal(
    selectOperator([a, b], { mode: "cheapest", region: "CDG", now }).id,
    b.id,
  );
  assert.equal(
    selectOperator([a, b], { mode: "cheapest", payer: a.payer, now }).id,
    a.id,
  );
  assert.throws(
    () =>
      selectOperator([{ ...a, healthy: false }, b], { payer: a.payer, now }),
    /unavailable/,
  );
});
async function setup(t) {
  const db = database(),
    env = {
      DB: db,
      NEIRO_MINT: mint,
      REQUEST_LIMIT: { limit: async () => ({ success: true }) },
    },
    row = await fixture(env);
  insert(db, row);
  t.after(() => db.sql.close());
  const map = cacheFixture(t);
  map.set("https://router.example/_regional/CDG/refresh", new Response("1"));
  return { db, env, row };
}
function request(path, body) {
  const r = new Request(
    "https://router.example" + path,
    body === undefined
      ? {}
      : {
          method: "POST",
          body,
          headers: { "content-type": "application/json" },
        },
  );
  Object.defineProperty(r, "cf", { value: { colo: "CDG" } });
  return r;
}
test("RPC preserves request/response text and makes one upstream call", async (t) => {
  const { env } = await setup(t),
    ctx = context(),
    raw = ' { "jsonrpc":"2.0", "id":1, "method":"getVersion", "params":{} } ',
    reply = ' {"jsonrpc":"2.0","id":1,"result":{"version":"fixture"}} ';
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    sent.push({ url, body: options.body });
    return new Response(reply);
  });
  const r = await worker.fetch(request("/rpc", raw), env, ctx);
  await ctx.finish();
  assert.equal(r.status, 200);
  assert.equal(await r.text(), reply);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, raw);
});
test("an upstream transport failure is returned without replay", async (t) => {
  const { env } = await setup(t),
    ctx = context();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw Error("fixture transport outage");
  });
  const r = await worker.fetch(
    request(
      "/rpc",
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getVersion" }),
    ),
    env,
    ctx,
  );
  await ctx.finish();
  assert.equal(r.status, 503);
  assert.equal(calls, 1);
});
test("expired listing is hidden by default and cannot receive pinned RPC", async (t) => {
  const { env, row, db } = await setup(t);
  row.listing.checkedAt = Date.now() - 900000;
  db.sql
    .prepare("UPDATE operators SET data=? WHERE id=?")
    .run(JSON.stringify(row), row.id);
  t.mock.method(globalThis, "fetch", async () =>
    assert.fail("no upstream allowed"),
  );
  let ctx = context(),
    r = await worker.fetch(request("/operators"), env, ctx);
  await ctx.finish();
  assert.deepEqual((await r.json()).operators, []);
  ctx = context();
  r = await worker.fetch(request("/operators?includeInactive=true"), env, ctx);
  await ctx.finish();
  const [inactive] = (await r.json()).operators;
  assert.equal(inactive.eligible, false);
  assert.equal(inactive.failureReason, "listing-expired-or-unchecked");
  ctx = context();
  r = await worker.fetch(
    request(
      "/rpc?provider=" + payer,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getVersion" }),
    ),
    env,
    ctx,
  );
  await ctx.finish();
  assert.equal(r.status, 503);
});

test("sign-only operators route signTransaction; signAndSend requires capability without replay",async(t)=>{
 const {db,env,row}=await setup(t);row.enabledMethods={sign_transaction:true,sign_and_send_transaction:false};
 db.sql.prepare('UPDATE operators SET data=? WHERE id=?').run(JSON.stringify(row),row.id);
 const calls=[];t.mock.method(globalThis,'fetch',async(_url,options)=>{calls.push(options.body);return Response.json({jsonrpc:'2.0',id:1,result:{ok:true}})});
 const ctx=context();
 const raw=JSON.stringify({jsonrpc:'2.0',id:1,method:'signTransaction',params:{}});
 assert.equal((await worker.fetch(request('/rpc',raw),env,ctx)).status,200);
 const unsupported=JSON.stringify({jsonrpc:'2.0',id:2,method:'signAndSendTransaction',params:{}});
 assert.equal((await worker.fetch(request('/rpc',unsupported),env,ctx)).status,503);
 assert.deepEqual(calls,[raw]);await ctx.finish();
});
test("unknown JSON-RPC methods pass through and old enrollment is gone",async(t)=>{
 const {env}=await setup(t);let n=0;
 t.mock.method(globalThis,'fetch',async()=>{n++;return Response.json({jsonrpc:'2.0',id:1,error:{code:-32601,message:'upstream method error'}})});
 const ctx=context();const raw=JSON.stringify({jsonrpc:'2.0',id:1,method:'futureKoraMethod',params:{hello:'world'}});
 const res=await worker.fetch(request('/rpc',raw),env,ctx);assert.equal(res.status,200);assert.equal((await res.json()).error.code,-32601);assert.equal(n,1);
 const removed=await worker.fetch(request('/operators/register',JSON.stringify({url:'https://arbitrary.example.com'})),env,context());assert.equal(removed.status,404);assert.equal(n,1);await ctx.finish();
});

test('expired cached funding re-reads D1 before routing, without probing operators',async(t)=>{
 const {env,row}=await setup(t),now=Date.now(),ctx=context();
 const old=await fixture(env,now-240000);
 // At snapshot creation (65s ago), funding was 175s old and still eligible.
 await caches.default.put(new Request('https://router.example/_pool-onchain-v1'),Response.json({at:now-65000,rows:[old]}));
 const sent=[];t.mock.method(globalThis,'fetch',async(url,options)=>{sent.push(url);return Response.json({jsonrpc:'2.0',id:1,result:{version:'test'}})});
 const r=await worker.fetch(request('/rpc',JSON.stringify({jsonrpc:'2.0',id:1,method:'getVersion'})),env,ctx);
 assert.equal(r.status,200);assert.deepEqual(sent,[row.url]);await ctx.finish();
});
test('already stale operators do not force a directory read on every request',async(t)=>{
 const {env,db}=await setup(t),old=await fixture(env,Date.now()-240000);
 db.sql.prepare('UPDATE operators SET data=? WHERE id=?').run(JSON.stringify(old),old.id);
 t.mock.method(globalThis,'fetch',()=>assert.fail('no foreground probe'));
 let ctx=context();await worker.fetch(request('/operators'),env,ctx);await ctx.finish();const reads=db.calls;
 ctx=context();await worker.fetch(request('/operators'),env,ctx);await ctx.finish();assert.equal(db.calls,reads);
});
