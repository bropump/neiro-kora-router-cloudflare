import assert from "node:assert/strict";
import test from "node:test";
import worker, { pruneRoutingState, recordConfig } from "../src/worker.ts";
import { MAINNET_GENESIS } from "../src/readiness.ts";
import { refreshRegional } from "../src/regional.ts";
import {
  recordActivity,
  activityFeed,
  reconcileActivity,
  acknowledgedSignatures,
} from "../src/activity.ts";
import {
  database,
  fixture,
  insert,
  mint,
  config,
  accounts,
  cacheFixture,
  context,
} from "./helpers.mjs";

test("cron archives a prolonged outage, preserves payer identity and stops network probes", async (t) => {
  cacheFixture(t);
  const DB = database(),
    env = { DB, NEIRO_MINT: mint };
  const row = await fixture(env);
  row.status = "disabled";
  row.healthy = false;
  row.offlineSince = Date.now() - 86400001;
  insert(DB, row);
  t.mock.method(globalThis, "fetch", () =>
    assert.fail("Archived operators must not trigger network probes"),
  );
  const ctx = context();
  await worker.scheduled({}, env, ctx);
  await ctx.finish();
  const stored = JSON.parse(
    DB.sql.prepare("SELECT data FROM operators WHERE id=?").get(row.id).data,
  );
  assert.equal(stored.status, "archived");
  assert.equal(stored.payer, row.payer);
  assert.equal(stored.identityBoundAt, row.identityBoundAt);
  assert.ok(stored.archivedAt);
});

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

test("retained activity counts follow status changes and deletion; reconciliation drains four batches", async (t) => {
  const DB = database(),
    env = { DB };
  let checks = 0;
  const sigs = Array.from({ length: 450 }, (_, i) =>
    String(i).padStart(64, "0"),
  );
  await recordActivity(env, "op", sigs);
  await recordActivity(env, "op", sigs);
  assert.equal(
    (await activityFeed(env)).counts.reduce((n, x) => n + x.count, 0),
    450,
  );
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const request = JSON.parse(init.body);
    checks++;
    assert.equal(request.method, "getSignatureStatuses");
    return Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: {
        value: request.params[0].map(() => ({
          slot: 123,
          err: null,
          confirmationStatus: "finalized",
        })),
      },
    });
  });
  await reconcileActivity(env);
  assert.equal(checks, 4);
  const counts = Object.fromEntries(
    (await activityFeed(env)).counts.map((x) => [x.status, x.count]),
  );
  assert.equal(counts.finalized, 400);
  assert.equal(counts.submitted, 50);
  DB.sql.exec("DELETE FROM network_transactions WHERE status='finalized'");
  assert.equal(
    (await activityFeed(env)).counts.reduce((n, x) => n + x.count, 0),
    50,
  );
});

test("activity admission caps retained data and bounded cleanup converges an oversized legacy database", async (t) => {
  const DB = database(),
    env = { DB };
  const now = Date.now();
  DB.sql
    .prepare(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<101100) INSERT INTO network_transactions(signature,operator_id,submitted_at,next_check_at,status) SELECT printf('%064d',i),'op',?,?,'finalized' FROM n",
    )
    .run(now, now);
  t.mock.method(globalThis, "fetch", () =>
    assert.fail("Finalized telemetry requires no network requests"),
  );
  await recordActivity(env, "op", ["new-signature"]);
  assert.equal(
    DB.sql.prepare("SELECT COUNT(*) n FROM network_transactions").get().n,
    101100,
  );
  await reconcileActivity(env);
  assert.equal(
    DB.sql.prepare("SELECT COUNT(*) n FROM network_transactions").get().n,
    100100,
  );
  assert.equal((await activityFeed(env)).trackingSaturated, true);
});

test("acknowledgement tracking ignores duplicate IDs, errors and sign-only replies", () => {
  const signature = "1".repeat(64),
    q = { jsonrpc: "2.0", id: 1, method: "signAndSendTransaction" };
  const r = { jsonrpc: "2.0", id: 1, result: { signature } };
  assert.deepEqual(acknowledgedSignatures(q, r), [signature]);
  assert.deepEqual(acknowledgedSignatures([q, q], r), []);
  assert.deepEqual(acknowledgedSignatures(q, [r, r]), []);
  assert.deepEqual(
    acknowledgedSignatures({ ...q, method: "signTransaction" }, r),
    [],
  );
  assert.deepEqual(
    acknowledgedSignatures(q, { ...r, error: { code: -1 } }),
    [],
  );
});

test("an archived operator can reverify with enrollment closed; the existing payer is preserved", async (t) => {
  cacheFixture(t);
  const DB = database(),
    env = {
      DB,
      NEIRO_MINT: mint,
      ENROLLMENT_OPEN: "false",
      REQUEST_LIMIT: { limit: async () => ({ success: true }) },
    };
  const row = await fixture(env);
  row.id = "a".repeat(32);
  row.status = "archived";
  row.healthy = false;
  row.offlineSince = Date.now() - 86400001;
  row.archivedAt = Date.now();
  insert(DB, row);
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (!init.body) return Response.json({ token: row.token, enabled: true });
    const { method } = JSON.parse(init.body);
    const result =
      method === "getPayerSigner"
        ? { signer_address: row.payer, payment_address: row.paymentAddress }
        : method === "getConfig"
          ? config
          : method === "getGenesisHash"
            ? MAINNET_GENESIS
            : method === "getMinimumBalanceForRentExemption"
              ? 2000000
              : method === "getMultipleAccounts"
                ? { context: { slot: 101 }, value: accounts() }
                : null;
    assert.notEqual(result, null, "Unexpected RPC " + method);
    return Response.json({ jsonrpc: "2.0", id: 1, result });
  });
  const response = await worker.fetch(
    new Request("https://router.example/operators/verify", {
      method: "POST",
      body: JSON.stringify({ id: row.id }),
    }),
    env,
    context(),
  );
  assert.equal(response.status, 200);
  const stored = JSON.parse(
    DB.sql.prepare("SELECT data FROM operators WHERE id=?").get(row.id).data,
  );
  assert.equal(stored.status, "active");
  assert.equal(stored.payer, row.payer);
  assert.equal(stored.archivedAt, null);
  assert.equal(stored.offlineSince, null);
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

test("delayed verification preserves a newer failed funding observation", async (t) => {
  cacheFixture(t);
  const DB = database(),
    env = {
      DB,
      NEIRO_MINT: mint,
      ENROLLMENT_OPEN: "false",
      REQUEST_LIMIT: { limit: async () => ({ success: true }) },
    };
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const row = await fixture(env);
  row.id = "b".repeat(32);
  row.status = "archived";
  row.healthy = false;
  insert(DB, row);
  let newer;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    if (!init.body) return Response.json({ token: row.token, enabled: true });
    const { method } = JSON.parse(init.body);
    let result;
    switch (method) {
      case "getPayerSigner":
        result = {
          signer_address: row.payer,
          payment_address: row.paymentAddress,
        };
        break;
      case "getConfig":
        result = config;
        break;
      case "getGenesisHash":
        result = MAINNET_GENESIS;
        break;
      case "getMinimumBalanceForRentExemption":
        result = 2000000;
        break;
      case "getMultipleAccounts":
        // Simulate the independent periodic lane completing while this older
        // request is still in flight. No network or signing occurs in this test.
        now += 100;
        newer = {
          ...row.funding,
          at: now,
          slot: 102,
          ready: false,
          reason: "neiro-ata-missing",
        };
        DB.sql
          .prepare(
            "UPDATE operators SET data=json_set(data,'$.funding',json(?)) WHERE id=?",
          )
          .run(JSON.stringify(newer), row.id);
        result = { context: { slot: 101 }, value: accounts() };
        break;
      default:
        assert.fail("Unexpected RPC " + method);
    }
    return Response.json({ jsonrpc: "2.0", id: 1, result });
  });
  const response = await worker.fetch(
    new Request("https://router.example/operators/verify", {
      method: "POST",
      body: JSON.stringify({ id: row.id }),
    }),
    env,
    context(),
  );
  assert.equal(response.status, 422);
  const stored = JSON.parse(
    DB.sql.prepare("SELECT data FROM operators WHERE id=?").get(row.id).data,
  );
  assert.deepEqual(stored.funding, newer);
  assert.equal(stored.healthy, false);
  assert.equal(stored.failureReason, "neiro-ata-missing");
});
