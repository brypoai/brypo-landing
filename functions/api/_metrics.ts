// functions/api/_metrics.ts
//
// Pure helpers for the /api/metrics distribution snapshot (D-1, docs/18 §3
// "Track D"). Kept dependency-free and side-effect-free so
// scripts/test-publish.mjs can import and unit-test them (Node type-stripping,
// no network).

export interface MetricsSnapshot {
  /** UTC date the snapshot was taken (YYYY-MM-DD). */
  date: string;
  x: {
    /** followers_count, or null when creds are unset / the X API call failed. */
    followers: number | null;
    handle: string | null;
    /** Present when followers is null, explaining why. */
    error?: string;
  };
  try: {
    /** publish:YYYY-MM-DD counter for today (UTC); 0 when unset. */
    publishCountToday: number;
    /** usage:YYYY-MM-DD accumulated USD spend for today (UTC); 0 when unset. */
    spendUsdToday: number;
  };
  /**
   * Waitlist signup count, fetched from the Tally API (form dWQlbq) when
   * TALLY_API_KEY is configured. null when the key is unset or the Tally
   * fetch failed — the log line then renders a fill-by-hand marker so the
   * gap stays explicit rather than silently missing (docs/18 §9.2).
   */
  waitlist: number | null;
}

/** Cell used for a value that has no automatic source (filled by hand). */
export const WAITLIST_MANUAL_CELL = "— (Tally 手記入)";

/** Escape the pipe so a free-text note can't break the Markdown table. */
function cell(v: string): string {
  return v.replace(/\|/g, "\\|");
}

/**
 * Render one METRICS_LOG.md table row from a snapshot. Column order matches
 * docs/METRICS_LOG.md: 日付 | X followers | waitlist | try 利用 | 備考.
 * The waitlist column is the Tally count when available, otherwise the
 * manual marker (see MetricsSnapshot).
 */
export function buildMetricsLogLine(snap: MetricsSnapshot, note = ""): string {
  const followers =
    snap.x.followers === null
      ? snap.x.error
        ? `n/a (${snap.x.error})`
        : "n/a"
      : String(snap.x.followers);
  const handle = snap.x.handle ? ` (@${snap.x.handle})` : "";
  const tryCell = `publish ${snap.try.publishCountToday} / $${snap.try.spendUsdToday.toFixed(4)}`;
  const waitlistCell =
    snap.waitlist === null ? WAITLIST_MANUAL_CELL : String(snap.waitlist);
  const cells = [
    snap.date,
    `${followers}${handle}`,
    waitlistCell,
    tryCell,
    note,
  ].map(cell);
  return `| ${cells.join(" | ")} |`;
}
