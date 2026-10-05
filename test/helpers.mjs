import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { address, getAddressEncoder } from "@solana/addresses";
import {
  fundingScope,
  associatedAddress,
  TOKEN_PROGRAM,
} from "../src/readiness.ts";

export const payer = "11111111111111111111111111111111";
export const mint = "CTg3ZgYx79zrE1MteDVkmkcGniiFrK1hJ6yiabropump";
export const config = {
  fee_payers: [payer],
  enabled_methods: Object.fromEntries(
    [
      "get_config",
      "get_payer_signer",
      "estimate_transaction_fee",
      "sign_transaction",
      "sign_and_send_transaction",
    ].map((x) => [x, true]),
  ),
  validation_config: {
    allowed_spl_paid_tokens: [mint],
    price: { type: "free" },
  },
};
export function database() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const db = {
    sql,
    calls: 0,
    withSession() {
      return this;
    },
    prepare(text) {
      const statement = sql.prepare(text);
      let args = [];
      return {
        bind(...a) {
          args = a;
          return this;
        },
        async run() {
          db.calls++;
          const r = statement.run(...args);
          return { success: true, meta: { changes: r.changes } };
        },
        async first() {
          db.calls++;
          return statement.get(...args) || null;
        },
        async all() {
          db.calls++;
          return { success: true, results: statement.all(...args) };
        },
      };
    },
    async batch(statements) {
      sql.exec("BEGIN");
      try {
        const values = [];
        for (const s of statements) values.push(await s.run());
        sql.exec("COMMIT");
        return values;
      } catch (e) {
        sql.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return db;
}
export async function fixture(env, now = Date.now()) {
  return {
    id: "fixture-operator",
    url: "https://kora.example.com/",
    token: "fixture-token",
    payer,
    paymentAddress: payer,
    status: "active",
    healthy: true,
    createdAt: now,
    identityBoundAt: now,
    checkedAt: now,
    verifiedAt: now,
    lastSuccessfulAt: now,
    price: { type: "free" },
    funding: {
      at: now,
      slot: 100,
      scope: await fundingScope(env),
      payer,
      paymentAddress: payer,
      ata: await associatedAddress(payer, mint),
      lamports: 100000,
      ready: true,
      reason: null,
    },
  };
}
export function insert(db, row) {
  db.sql
    .prepare(
      "INSERT INTO operators(id,host,status,created_at,checked_at,last_attempt,data) VALUES (?,?,?,?,?,?,?)",
    )
    .run(
      row.id,
      new URL(row.url).hostname,
      row.status,
      row.createdAt,
      row.checkedAt,
      0,
      JSON.stringify(row),
    );
}
export function accounts(balance = 100000) {
  const token = new Uint8Array(165),
    enc = getAddressEncoder();
  token.set(enc.encode(address(mint)));
  token.set(enc.encode(address(payer)), 32);
  token[108] = 1;
  return [
    {
      owner: payer,
      executable: false,
      lamports: balance,
      data: ["", "base64"],
    },
    {
      owner: TOKEN_PROGRAM,
      executable: false,
      lamports: 2000000,
      data: [Buffer.from(token).toString("base64"), "base64"],
    },
  ];
}
export function cacheFixture(t) {
  const previous = globalThis.caches,
    map = new Map();
  globalThis.caches = {
    default: {
      async match(r) {
        return map.get(typeof r === "string" ? r : r.url)?.clone();
      },
      async put(r, v) {
        map.set(typeof r === "string" ? r : r.url, v.clone());
      },
      async delete(r) {
        return map.delete(typeof r === "string" ? r : r.url);
      },
    },
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.caches;
    else globalThis.caches = previous;
  });
  return map;
}
export function context() {
  const pending = [];
  return {
    waitUntil(p) {
      pending.push(p);
    },
    async finish() {
      await Promise.all(pending);
    },
  };
}
