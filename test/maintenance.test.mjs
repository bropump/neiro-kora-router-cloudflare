import assert from "node:assert/strict";
import test from "node:test";
import { pruneRoutingState, recordConfig } from "../src/worker.ts";
import { refreshRegional } from "../src/regional.ts";
import { database, fixture, insert, mint, config, cacheFixture } from "./helpers.mjs";
for (const count of [100, 1000])
  test(`${count} operators: regional work stays bounded and oldest-first attempts survive pruning`, async (t) => {
    const cache = cacheFixture(t),
      DB = database(),
      env = { DB, NEIRO_MINT: mint };
    const base = await fixture(env),
      rows = Array.from({ length: count }, (_, i) => ({
        ...base,
        id: "operator-" + String(i).padStart(4, "0"),
      }));
    rows.forEach((row) => insert(DB, row));
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    t.mock.method(globalThis, "fetch", async () =>
      Response.json({ jsonrpc: "2.0", id: 1, result: config }),
    );
    let quotes = 0;
    const probe = async () => {
      quotes++;
      return { ok: true, ms: 10, feeInToken: 0, feeInLamports: 5000 };
    };
    await refreshRegional(rows, env, "https://router.example", "CDG", probe);
    assert.equal(quotes, 12);
    assert.equal(fetch.mock.callCount(), 12);
    const firstCost = DB.calls;
    assert.ok(firstCost < 200, `D1 statements=${firstCost}`);
    now += 16 * 60000;
    await pruneRoutingState(env, now);
    cache.clear();
    await refreshRegional(rows, env, "https://router.example", "CDG", probe);
    assert.equal(quotes, 24);
    assert.equal(
      DB.sql
        .prepare(
          "SELECT COUNT(*) AS n FROM regional_stats WHERE last_probe_at>0",
        )
        .get().n,
      24,
    );
  });

test("config event does not reject newer funding/ownership evidence as future", async (t) => {
  cacheFixture(t);
  const DB = database(),
    env = { DB, NEIRO_MINT: mint };
  const row = await fixture(env);
  row.checkedAt -= 1000;
  insert(DB, row);
  await recordConfig(env, "https://router.example", row, {
    ok: true,
    config,
    at: Date.now() - 100,
    ms: 5,
  });
  const current = JSON.parse(
    DB.sql.prepare("SELECT data FROM operators WHERE id=?").get(row.id).data,
  );
  assert.equal(current.status, "active");
  assert.equal(current.failureReason, null);
});

test("completed regional probes evict the cold snapshot immediately",async(t)=>{
 const cache=cacheFixture(t),DB=database(),env={DB,NEIRO_MINT:mint};t.after(()=>DB.sql.close());const row=await fixture(env);insert(DB,row);
 const key='https://router.example/_regional/CDG/stats';cache.set(key,Response.json({at:Date.now(),rows:[]}));
 t.mock.method(globalThis,'fetch',async()=>Response.json({jsonrpc:'2.0',id:1,result:config}));
 await refreshRegional([row],env,'https://router.example','CDG',async()=>({ok:true,ms:8,feeInToken:0,feeInLamports:0}));
 assert.equal(cache.has(key),false);assert.equal(JSON.parse(DB.sql.prepare("SELECT sample_json FROM regional_stats WHERE region='CDG'").get().sample_json).ewmaMs,8);
});
