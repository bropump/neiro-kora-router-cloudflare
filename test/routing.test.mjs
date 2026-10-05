import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.ts";
import { selectOperator } from "../src/selection.ts";
import {
  ownershipFresh,
  lifecycleFailure,
  shouldArchive,
  ARCHIVE_AFTER_MS,
  OWNERSHIP_MAX_AGE_MS,
} from "../src/lifecycle.ts";
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
test("outages keep their start time, expire ownership, and archive after24h", async () => {
  const now = Date.now(),
    row = await fixture({ NEIRO_MINT: mint }, now);
  const first = lifecycleFailure(row, "offline", now),
    second = lifecycleFailure({ ...row, ...first }, "offline", now + 60000);
  assert.equal(first.offlineSince, second.offlineSince);
  assert.equal(
    shouldArchive(
      { ...row, status: "disabled", ...second },
      now + ARCHIVE_AFTER_MS,
    ),
    true,
  );
  assert.equal(ownershipFresh(row, now + OWNERSHIP_MAX_AGE_MS), false);
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
test("expired ownership is hidden by default and cannot receive pinned RPC", async (t) => {
  const { env, row, db } = await setup(t);
  row.verifiedAt = Date.now() - OWNERSHIP_MAX_AGE_MS;
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
  assert.equal(inactive.failureReason, "ownership-check-expired");
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
