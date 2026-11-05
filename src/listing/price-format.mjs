// NPN listing price schema validation only. No fee calculation.
import assert from 'node:assert/strict';
export const NEIRO = 'CTg3ZgYx79zrE1MteDVkmkcGniiFrK1hJ6yiabropump';
const U64 = (1n << 64n) - 1n;
function uint(value, label) {
  assert.ok(typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value)) ||
    (typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value)), label);
  const n = BigInt(value); assert.ok(n >= 0n && n <= U64, label); return n;
}
function decimal(value) {
  const s = String(value);
  assert.match(s, /^(0|[1-9][0-9]{0,9})(\.[0-9]{1,28})?$/, 'plain nonnegative decimal required');
  const [whole, fraction=''] = s.split('.');
  return [BigInt(whole + fraction), 10n ** BigInt(fraction.length)];
}
export function validatePrice(price) {
  const fields = {free:['type'], fixed:['amount','strict','token','type'], margin:['margin','type']}[price?.type];
  assert.ok(fields, 'unsupported price model');
  assert.deepEqual(Object.keys(price).sort(),fields,'unexpected price fields');
  if (price.type === 'fixed') {
    uint(price.amount,'fixed amount'); assert.equal(price.token,NEIRO,'fixed mint');
    assert.equal(typeof price.strict,'boolean','fixed strict');
  }
  if (price.type === 'margin') decimal(price.margin);
  return price;
}
