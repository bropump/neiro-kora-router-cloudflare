import assert from "node:assert/strict";
import test from "node:test";
import {
  checkFunding,
  decodeFunding,
  fundingExclusion,
  fundingScope,
  associatedAddress,
  MAINNET_GENESIS,
  FUNDING_MAX_AGE_MS,
} from "../src/readiness.ts";
import { configCheck } from "../src/policy.ts";
import { accounts, fixture, mint, payer, config } from "./helpers.mjs";

test("funded plain SOL payer and an initialized zero-token ATA qualify", async () => {
  const env = { NEIRO_MINT: mint },
    row = await fixture(env),
    [sol, ata] = accounts();
  const f = decodeFunding(
    sol,
    ata,
    row,
    mint,
    await associatedAddress(payer, mint),
    1488440,
    100,
    await fundingScope(env),
  );
  assert.equal(f.ready, true);
  assert.equal(fundingExclusion({ ...row, funding: f }, f.scope), null);
  for (const [changed, reason] of [
    [null, "neiro-ata-missing"],
    [{ ...ata, lamports: 1 }, "neiro-ata-not-rent-exempt"],
    [{ ...ata, owner: payer }, "neiro-ata-program"],
  ])
    assert.equal(
      decodeFunding(sol, changed, row, mint, f.ata, 1488440, 100, f.scope)
        .reason,
      reason,
    );
  for (const state of [0, 2]) {
    const bytes = Buffer.from(ata.data[0], "base64");
    bytes[108] = state;
    assert.equal(
      decodeFunding(
        sol,
        { ...ata, data: [bytes.toString("base64"), "base64"] },
        row,
        mint,
        f.ata,
        1488440,
        100,
        f.scope,
      ).ready,
      false,
    );
  }
});
test("funding evidence expires, binds RPC scope and respects sampled SOL fee", async () => {
  const env = { NEIRO_MINT: mint },
    row = await fixture(env),
    f = row.funding;
  assert.equal(
    fundingExclusion({ ...row, funding: { ...f, lamports: 4999 } }, f.scope),
    "insufficient-sol",
  );
  assert.equal(
    fundingExclusion(
      { ...row, sampleQuote: { ok: true, at: f.at, feeInLamports: 200000 } },
      f.scope,
    ),
    "insufficient-sol",
  );
  assert.equal(
    fundingExclusion(row, f.scope, f.at + FUNDING_MAX_AGE_MS),
    "funding-stale-or-unchecked",
  );
  assert.equal(
    fundingExclusion(
      row,
      await fundingScope({
        ...env,
        FUNDING_RPC_URL: "https://other.example.com",
      }),
    ),
    "funding-stale-or-unchecked",
  );
});
test("one invalid legacy identity is isolated from a healthy funding batch", async (t) => {
  const env = { NEIRO_MINT: mint },
    row = await fixture(env);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const q = JSON.parse(options.body);
    calls.push(q.method);
    let result;
    if (q.method === "getGenesisHash") result = MAINNET_GENESIS;
    else if (q.method === "getMinimumBalanceForRentExemption") result = 1488440;
    else if (q.method === "getMultipleAccounts") {
      assert.equal(q.params[0].length, 2);
      result = { context: { slot: 101 }, value: accounts() };
    } else assert.fail(q.method);
    return Response.json({ jsonrpc: "2.0", id: 1, result });
  });
  const states = await checkFunding(env, [{ ...row, payer: "invalid" }, row]);
  assert.equal(states[0].reason, "invalid-operator-address");
  assert.equal(states[1].ready, true);
  assert.equal(calls.length, 3);
});
test("payment operators must expose both supported signing paths", () => {
  const identity = { signer_address: payer, payment_address: payer };
  assert.equal(configCheck(config, identity, mint).payer, payer);
  assert.throws(
    () =>
      configCheck(
        {
          ...config,
          enabled_methods: {
            ...config.enabled_methods,
            sign_transaction: false,
          },
        },
        identity,
        mint,
      ),
    /methods unavailable/,
  );
});
