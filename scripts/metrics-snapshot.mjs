/**
 * scripts/metrics-snapshot.mjs
 *
 * Fetch GET /api/metrics and print a ready-to-paste docs/METRICS_LOG.md row
 * (D-1, docs/18 §3 "Track D"). Run weekly.
 *
 *   PUBLISH_TOKEN=… node scripts/metrics-snapshot.mjs [--base https://brypo.com]
 *
 * The owner token is read from $PUBLISH_TOKEN (never pass it on argv — it would
 * leak into shell history and the process list). The full JSON goes to stderr
 * for inspection; the single log line goes to stdout so it can be piped/appended:
 *
 *   PUBLISH_TOKEN=… node scripts/metrics-snapshot.mjs >> ../brypo/docs/METRICS_LOG.md
 *
 * Then fill the waitlist cell by hand from the Tally dashboard (docs/18 §9.2).
 * Requires Node >= 22 (global fetch). Network required (hits the deployed fn).
 */

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const base = argValue("--base", process.env.METRICS_BASE_URL || "https://brypo.com").replace(
  /\/+$/,
  "",
);
const token = process.env.PUBLISH_TOKEN || "";
if (!token) {
  console.error("PUBLISH_TOKEN env var is required (do not pass the token on argv).");
  process.exit(2);
}

const url = `${base}/api/metrics`;
let res;
try {
  res = await fetch(url, { headers: { "X-Publish-Token": token } });
} catch (e) {
  console.error(`network error reaching ${url}: ${e?.message ?? e}`);
  process.exit(1);
}

const body = await res.json().catch(() => null);
if (!res.ok || !body) {
  console.error(`metrics endpoint returned ${res.status}: ${JSON.stringify(body)}`);
  process.exit(1);
}

// Full snapshot to stderr for the operator to eyeball.
console.error(JSON.stringify(body, null, 2));
if (Array.isArray(body.notes)) {
  for (const n of body.notes) console.error(`note: ${n}`);
}

if (typeof body.logLine === "string") {
  process.stdout.write(body.logLine + "\n");
} else {
  console.error("no logLine in response");
  process.exit(1);
}
