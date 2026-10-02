import semver from 'semver';
import {bounded} from './policy.mjs';
import {upstream} from './upstream.mjs';

export const DAY_MS = 86400000;
export const GRACE_MS = 3 * DAY_MS;
const RELEASES_URL = 'https://api.github.com/repos/solana-foundation/kora/releases?per_page=100';

export function latestServerRelease(releases) {
  if (!Array.isArray(releases)) throw Error('Invalid release feed');
  const versions = releases.filter(r => !r.draft && r.published_at && /^v\d/.test(r.tag_name))
    .map(r => semver.valid(r.tag_name)).filter(Boolean);
  if (!versions.length) throw Error('No Kora server release');
  return versions.sort(semver.rcompare)[0];
}

// Separate from health/config status: a healthy response cannot clear this gate.
// Keep every observed release deadline so another release cannot restart grace.
export function versionStatus(row, releases, now = Date.now()) {
  if (!releases.length) return {eligible:true, status:'awaiting-release-feed'};
  const ordered = [...releases].sort((a,b) => semver.rcompare(a.version,b.version));
  const report = row.koraVersion;
  const version = semver.valid(report?.version ?? '');
  const latest = ordered[0].version;
  const firstSeen = Math.min(...ordered.map(r => r.first_seen_at));
  const lastSuccess = report?.lastSuccessAt;
  const staleAt = (Number.isSafeInteger(lastSuccess) ? lastSuccess : Math.max(row.createdAt,firstSeen)) + GRACE_MS;
  const missing = ordered.filter(r => !version || semver.lt(version,r.version));
  const upgradeBy = missing.length ? Math.min(...missing.map(r => r.first_seen_at + GRACE_MS)) : null;
  const stale = now >= staleAt;
  const outdated = upgradeBy !== null && now >= upgradeBy;
  return {
    eligible:!stale && !outdated,
    status:stale ? 'version-unavailable' : outdated ? 'outdated' : missing.length ? 'upgrade-grace' : 'current',
    version, latest, checkedAt:report?.checkedAt ?? null, lastSuccessAt:lastSuccess ?? null,
    upgradeBy, verificationExpiresAt:staleAt,
  };
}

async function refreshReleaseTarget(env, now) {
  const lease = await env.DB.prepare(`INSERT INTO regional_leases(id,n,reset) VALUES ('kora-release-check',1,?)
    ON CONFLICT(id) DO UPDATE SET reset=excluded.reset WHERE regional_leases.reset<=? RETURNING id`)
    .bind(now+DAY_MS,now).first();
  if (!lease) return;
  try {
    const response = await fetch(RELEASES_URL, {headers:{accept:'application/vnd.github+json','user-agent':'neiro-kora-router'},redirect:'error',signal:AbortSignal.timeout(8000)});
    if (!response.ok) throw Error('Release feed unavailable');
    const version = latestServerRelease(JSON.parse(await bounded(response,2097152)));
    const known = await env.DB.prepare('SELECT version FROM kora_releases').all();
    // A deleted release or transient feed rollback must not lower the requirement.
    if (known.results.some(r => semver.gte(r.version,version))) return;
    await env.DB.prepare('INSERT OR IGNORE INTO kora_releases(version,first_seen_at) VALUES (?,?)').bind(version,now).run();
  } catch {
    // Retain known deadlines; retry a failed feed lookup in an hour.
    await env.DB.prepare("UPDATE regional_leases SET reset=? WHERE id='kora-release-check' AND reset=?")
      .bind(now+3600000,now+DAY_MS).run();
  }
}

export async function checkOperatorVersion(env, id, now = Date.now()) {
  // Claim before the RPC call. Admission and cron share the same daily budget.
  const stored = await env.DB.prepare(`UPDATE operators SET data=json_set(data,
    '$.koraVersion.checkedAt',?) WHERE id=? AND
    (json_extract(data,'$.koraVersion.checkedAt') IS NULL OR json_extract(data,'$.koraVersion.checkedAt')<=?) RETURNING data`)
    .bind(now,id,now-DAY_MS).first();
  if (!stored) return;
  const row = JSON.parse(stored.data);
  try {
    const response = await upstream(row.url,'getVersion',{},3000);
    const version = semver.valid(response.value.result?.version ?? '');
    if (response.value.error || !version) throw Error('Invalid Kora version');
    await env.DB.prepare(`UPDATE operators SET data=json_set(data,'$.koraVersion.version',?,
      '$.koraVersion.lastSuccessAt',?,'$.koraVersion.error',json('false'))
      WHERE id=? AND json_extract(data,'$.koraVersion.checkedAt')=?`)
      .bind(version,now,id,now).run();
  } catch {
    // Preserve the last successful version through a transient outage.
    await env.DB.prepare(`UPDATE operators SET data=json_set(data,'$.koraVersion.error',json('true'))
      WHERE id=? AND json_extract(data,'$.koraVersion.checkedAt')=?`).bind(id,now).run();
  }
}

export async function refreshVersions(env, now = Date.now()) {
  await refreshReleaseTarget(env,now);
  // The minute scheduler drains large directories in batches; each provider is
  // contacted at most once per 24 hours, including providers excluded by version.
  const rows = await env.DB.prepare(`SELECT id FROM operators WHERE status!='pending' AND
    (json_extract(data,'$.koraVersion.checkedAt') IS NULL OR json_extract(data,'$.koraVersion.checkedAt')<=?)
    ORDER BY COALESCE(json_extract(data,'$.koraVersion.checkedAt'),0),id LIMIT 100`).bind(now-DAY_MS).all();
  for (let i=0;i<rows.results.length;i+=4) {
    await Promise.all(rows.results.slice(i,i+4).map(row => checkOperatorVersion(env,row.id,now)));
  }
}
