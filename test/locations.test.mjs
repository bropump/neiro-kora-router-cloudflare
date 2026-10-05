import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import worker from "../src/worker.ts";
import { dashboard } from "../src/dashboard.ts";
import { fundingScope } from "../src/readiness.ts";

const payer = "11111111111111111111111111111111";
const url = "https://operator.example.com/";
const hosting = ["Frankfurt, Germany", "New York, USA", "Sydney, Australia"];

async function directory(
  t,
  colo,
  hostingRegions,
  configuredRegions,
  cached = false,
) {
  const now = Date.now();
  const row = {
    id: "fixture-operator",
    payer,
    paymentAddress: payer,
    url,
    status: "active",
    healthy: true,
    checkedAt: now,
    verifiedAt: now,
    funding: {
      at: now,
      scope: await fundingScope({ NEIRO_MINT: payer }),
      payer,
      paymentAddress: payer,
      lamports: 100000,
      ready: true,
      reason: null,
    },
    hostingRegions,
    price: { type: "free" },
  };
  const cache = new Map();
  if (cached)
    cache.set(
      "https://router.example/_pool-v2",
      Response.json({ at: now, rows: [row] }),
    );
  t.mock.method(globalThis, "fetch", async () => {
    assert.fail("No external requests permitted");
  });
  const previousCaches = globalThis.caches;
  globalThis.caches = {
    default: {
      match: async (key) => cache.get(key.url)?.clone(),
      put: async (key, response) => {
        cache.set(key.url, response.clone());
      },
    },
  };
  t.after(() => {
    if (previousCaches === undefined) delete globalThis.caches;
    else globalThis.caches = previousCaches;
  });
  const db = {
    withSession: () => db,
    prepare(sql) {
      return {
        bind() {
          return this;
        },
        async first() {
          assert.match(sql, /INSERT INTO regional_leases/);
          return null;
        },
        async all() {
          if (sql.includes("SELECT data FROM operators"))
            return { results: [{ data: JSON.stringify(row) }] };
          if (
            sql.includes("FROM regional_stats") ||
            sql.includes("FROM operator_observations")
          )
            return { results: [] };
          assert.fail("Unexpected query: " + sql);
        },
      };
    },
  };
  const env = {
    DB: db,
    REQUEST_LIMIT: { limit: async () => ({ success: true }) },
    NEIRO_MINT: payer,
  };
  if (configuredRegions !== undefined)
    env.CONFIGURED_OPERATORS = JSON.stringify([
      { url, payer, paymentAddress: payer, hostingRegions: configuredRegions },
    ]);
  const request = new Request("https://router.example/operators");
  if (colo !== undefined)
    Object.defineProperty(request, "cf", { value: { colo } });
  const pending = [];
  const response = await worker.fetch(request, env, {
    waitUntil: (p) => pending.push(p),
  });
  await Promise.all(pending);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json();
}

for (const colo of ["CDG", "FRA", "SYD", undefined]) {
  test(`Kora hosting locations are preserved with measurement colo ${colo}`, async (t) => {
    const result = await directory(t, colo, hosting);
    assert.equal(result.measurementColo, colo ?? "unknown");
    assert.equal(Object.hasOwn(result, "colo"), false);
    assert.deepEqual(result.operators[0].hostingRegions, hosting);
  });
}

test("an unreported host never inherits the caller measurement location", async (t) => {
  const result = await directory(t, "CDG", undefined);
  assert.deepEqual(result.operators[0].hostingRegions, []);
});

test("configured hosting metadata takes effect over an older cached empty record", async (t) => {
  const result = await directory(t, "CDG", [], hosting, true);
  assert.deepEqual(result.operators[0].hostingRegions, hosting);
});

test("clearing configured hosting metadata removes stale cached locations", async (t) => {
  const result = await directory(t, "CDG", hosting, [], true);
  assert.deepEqual(result.operators[0].hostingRegions, []);
});

// Run the actual dashboard script with an in-memory DOM; inspect displayed cells.
class Element {
  children = [];
  textContent = "";
  value = "speed";
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = children;
  }
  addEventListener() {}
  setAttribute() {}
  scrollIntoView() {}
}

test("dashboard separates host labels from measurement labels without a colo alias", async () => {
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const operators = [hosting, []].map((hostingRegions, i) => ({
    id: `operator-${i}`,
    payer,
    hostingRegions,
    eligible: true,
    sampleEwmaMs: 10,
    price: { type: "free" },
  }));
  const data = { measurementColo: "CDG", operators };
  const context = vm.createContext({
    document: { getElementById: el, createElement: () => new Element() },
    location: { origin: "https://router.example" },
    setInterval() {},
    fetch: async (path) => {
      if (path === "/operators") return Response.json(data);
      if (path === "/network/measurements")
        return Response.json({ measurements: [], truncated: false });
      if (path === "/network/activity")
        return Response.json({
          counts: [],
          recent: [],
          startedAt: Date.now(),
        });
      assert.fail("Unexpected request: " + path);
    },
  });
  const script = dashboard.match(/<script>([\s\S]*)<\/script>/)[1];
  vm.runInContext(script, context);
  await vm.runInContext("refresh()", context);
  assert.match(el("status").textContent, /^Updated /);
  assert.equal(
    el("operators").children[0].children[1].textContent,
    hosting.join(" · "),
  );
  assert.equal(
    el("operators").children[1].children[1].textContent,
    "Unknown — operator has not reported a location",
  );
  assert.equal(
    el("colo").textContent,
    "Latency measured from Cloudflare: CDG (not the Kora hosting location)",
  );
  assert.ok(
    !el("operators").children.some((row) =>
      row.children[1].textContent.includes("CDG"),
    ),
  );
});
