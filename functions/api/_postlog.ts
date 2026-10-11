// functions/api/_postlog.ts
//
// Pure helpers for /api/post-log — the record behind the daily draft notification
// (docs/post-notify.md). Two kinds of rows live in ONE small KV document:
//
//   sends[date]  written by the machine (scripts/post-notify.mjs) after each
//                daily run: how many drafts went out, and in which mode.
//   weeks[sun]   written by the owner on /ops once a week (Sunday): posts
//                made that week and a 1–5 mood score. Under a minute.
//
// judge() applies the pre-agreed lines (docs/post-notify.md §判定の線) to that
// document. It is a rule lookup, not an opinion: the window is fixed from the
// first LIVE notification, and the verdict only becomes final after the window ends
// (mid-window it reports progress, never an early call).
//
// No I/O, no env — unit-tested by scripts/test-postnotify.mjs.

export const POST_LOG_KEY = "postlog:v1";

export type SendMode = "live" | "dry_run";

export interface SendRow {
  drafts: number;
  mode: SendMode;
  at: string;
}

export interface WeekRow {
  posts: number;
  mood: number;
  at: string;
}

export interface PostLog {
  /** JST date (YYYY-MM-DD) of the first live notification — starts the window. */
  first_live: string | null;
  sends: Record<string, SendRow>;
  /** Keyed by the Sunday (JST) that closes the Mon–Sun week. */
  weeks: Record<string, WeekRow>;
}

export const WINDOW_WEEKS = 6;
export const MAX_EXTENSIONS = 1;
export const LINES = {
  continueMinPosts: 3, // a "good week" posts at least this many
  continueMinWeeks: 4, // …and at least this many good weeks
  continueMinMood: 4.0,
  stopMaxPosts: 1, // a "dead week" posts fewer than this
  stopMinWeeks: 3, // …and at least this many dead weeks
  stopMaxMood: 2.0,
} as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function emptyLog(): PostLog {
  return { first_live: null, sends: {}, weeks: {} };
}

/** Parse the stored document, dropping anything malformed. */
export function parseLog(raw: string | null): PostLog {
  const log = emptyLog();
  if (raw === null) return log;
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return log;
  }
  if (obj === null || typeof obj !== "object") return log;
  if (typeof obj.first_live === "string" && DATE_RE.test(obj.first_live)) log.first_live = obj.first_live;
  for (const [d, r] of Object.entries(obj.sends ?? {})) {
    const m = toSendRow(d, r);
    if (m) log.sends[d] = m;
  }
  for (const [d, r] of Object.entries(obj.weeks ?? {})) {
    const w = toWeekRow(d, r);
    if (w) log.weeks[d] = w;
  }
  return log;
}

function toSendRow(date: string, r: any): SendRow | null {
  if (!DATE_RE.test(date) || r === null || typeof r !== "object") return null;
  if (!Number.isInteger(r.drafts) || r.drafts < 0 || r.drafts > 10) return null;
  if (r.mode !== "live" && r.mode !== "dry_run") return null;
  return { drafts: r.drafts, mode: r.mode, at: typeof r.at === "string" ? r.at : "" };
}

function toWeekRow(sunday: string, r: any): WeekRow | null {
  if (!DATE_RE.test(sunday) || !isSunday(sunday) || r === null || typeof r !== "object") return null;
  if (!Number.isInteger(r.posts) || r.posts < 0 || r.posts > 200) return null;
  if (!Number.isInteger(r.mood) || r.mood < 1 || r.mood > 5) return null;
  return { posts: r.posts, mood: r.mood, at: typeof r.at === "string" ? r.at : "" };
}

// ---- dates (all YYYY-MM-DD, calendar arithmetic in UTC) ---------------------

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function isSunday(date: string): boolean {
  return DATE_RE.test(date) && weekday(date) === 0;
}

/** The Sunday closing the week `date` belongs to (Mon–Sun weeks). */
export function weekSunday(date: string): string {
  const wd = weekday(date);
  return wd === 0 ? date : addDays(date, 7 - wd);
}

/** The week the owner most likely means to record on `today`: this Sunday if
 *  today is Sunday, otherwise the Sunday just past. */
export function defaultRecordWeek(today: string): string {
  const wd = weekday(today);
  return wd === 0 ? today : addDays(today, -wd);
}

// ---- writes -----------------------------------------------------------------

export type LogInput =
  | { kind: "send"; date: string; drafts: number; mode: SendMode }
  | { kind: "weekly"; week: string; posts: number; mood: number };

/** Validate a POST body. Returns the typed input, or an error string. */
export function parseLogInput(body: any): LogInput | string {
  if (body === null || typeof body !== "object") return "body must be a JSON object";
  if (body.kind === "send") {
    if (!DATE_RE.test(body.date ?? "")) return "date must be YYYY-MM-DD";
    if (!Number.isInteger(body.drafts) || body.drafts < 0 || body.drafts > 10) return "drafts must be an integer 0–10";
    if (body.mode !== "live" && body.mode !== "dry_run") return 'mode must be "live" or "dry_run"';
    return { kind: "send", date: body.date, drafts: body.drafts, mode: body.mode };
  }
  if (body.kind === "weekly") {
    if (!isSunday(body.week ?? "")) return "week must be a Sunday (YYYY-MM-DD)";
    if (!Number.isInteger(body.posts) || body.posts < 0 || body.posts > 200) return "posts must be an integer 0–200";
    if (!Number.isInteger(body.mood) || body.mood < 1 || body.mood > 5) return "mood must be an integer 1–5";
    return { kind: "weekly", week: body.week, posts: body.posts, mood: body.mood };
  }
  return 'kind must be "send" or "weekly"';
}

/** Apply one validated write. Returns a new document (input untouched). */
export function applyLogInput(log: PostLog, input: LogInput, nowIso: string): PostLog {
  const next: PostLog = { first_live: log.first_live, sends: { ...log.sends }, weeks: { ...log.weeks } };
  if (input.kind === "send") {
    const prev = next.sends[input.date];
    // A dry run never overwrites a live row of the same day.
    if (!(prev?.mode === "live" && input.mode === "dry_run")) {
      next.sends[input.date] = { drafts: input.drafts, mode: input.mode, at: nowIso };
    }
    if (input.mode === "live" && (next.first_live === null || input.date < next.first_live)) {
      next.first_live = input.date;
    }
  } else {
    next.weeks[input.week] = { posts: input.posts, mood: input.mood, at: nowIso };
  }
  return next;
}

/** Has today's run already happened for `mode`? (live also covers dry_run.) */
export function alreadyRan(log: PostLog, date: string, mode: SendMode): boolean {
  const row = log.sends[date];
  if (!row) return false;
  return row.mode === "live" || row.mode === mode;
}

// ---- judgment ---------------------------------------------------------------

export type Verdict = "continue" | "stop" | "neither";

export interface JudgedWeek {
  /** Monday … Sunday of the week. */
  from: string;
  sunday: string;
  /** Live drafts delivered that week (machine record). */
  drafts: number;
  /** Owner record; null when the week was not recorded. */
  posts: number | null;
  mood: number | null;
}

export interface WindowResult {
  index: number; // 0 = first window, 1 = the one extension
  from: string; // Monday of week 1
  to: string; // Sunday of week 6
  weeks: JudgedWeek[];
  goodWeeks: number;
  deadWeeks: number;
  unrecorded: number;
  moodAvg: number | null;
  /** Posts / drafts delivered — the reference figure, not a gate. */
  postRate: number | null;
  /** null while the window is still running. */
  verdict: Verdict | null;
}

export interface Judgment {
  status: "not_started" | "running" | "decided" | "owner_call";
  first_live: string | null;
  windows: WindowResult[];
  summary: string;
}

/** Monday the first judged week starts: the first live day itself when it is
 *  a Monday, otherwise the next Monday (the days before are a lead-in). */
export function windowStart(firstLive: string): string {
  const wd = weekday(firstLive);
  return wd === 1 ? firstLive : addDays(firstLive, ((8 - wd) % 7) || 7);
}

function judgeWindow(log: PostLog, index: number, from: string, today: string): WindowResult {
  const weeks: JudgedWeek[] = [];
  for (let i = 0; i < WINDOW_WEEKS; i++) {
    const mon = addDays(from, i * 7);
    const sun = addDays(mon, 6);
    let drafts = 0;
    for (let d = 0; d < 7; d++) {
      const row = log.sends[addDays(mon, d)];
      if (row?.mode === "live") drafts += row.drafts;
    }
    const w = log.weeks[sun];
    weeks.push({ from: mon, sunday: sun, drafts, posts: w ? w.posts : null, mood: w ? w.mood : null });
  }
  const to = weeks[weeks.length - 1].sunday;
  // An unrecorded week counts as zero posts — the record is the evidence.
  // Only weeks that have ended are counted, so mid-window progress never
  // shows future weeks as "dead" (at verdict time every week has ended).
  const postsOf = (w: JudgedWeek) => w.posts ?? 0;
  const ended = weeks.filter((w) => w.sunday < today || (w.sunday === today && w.posts !== null));
  const goodWeeks = ended.filter((w) => postsOf(w) >= LINES.continueMinPosts).length;
  const deadWeeks = ended.filter((w) => postsOf(w) < LINES.stopMaxPosts).length;
  const unrecorded = weeks.filter((w) => w.posts === null && w.sunday <= today).length;
  const moods = weeks.map((w) => w.mood).filter((m): m is number => m !== null);
  const moodAvg = moods.length ? Math.round((moods.reduce((a, b) => a + b, 0) / moods.length) * 100) / 100 : null;
  const draftSum = weeks.reduce((a, w) => a + w.drafts, 0);
  const postSum = weeks.reduce((a, w) => a + (w.posts ?? 0), 0);
  const postRate = draftSum > 0 ? Math.round((postSum / draftSum) * 100) / 100 : null;

  let verdict: Verdict | null = null;
  if (today > to) {
    const cont =
      goodWeeks >= LINES.continueMinWeeks && moodAvg !== null && moodAvg >= LINES.continueMinMood;
    const stop = deadWeeks >= LINES.stopMinWeeks || (moodAvg !== null && moodAvg <= LINES.stopMaxMood);
    verdict = cont ? "continue" : stop ? "stop" : "neither";
  }
  return { index, from, to, weeks, goodWeeks, deadWeeks, unrecorded, moodAvg, postRate, verdict };
}

/** Apply the lines as of `today` (JST date). */
export function judge(log: PostLog, today: string): Judgment {
  if (log.first_live === null) {
    return {
      status: "not_started",
      first_live: null,
      windows: [],
      summary: "まだ本番の通知が1件も届いていません（dry-run 中）。初回の本番通知の日から判定期間が始まります。",
    };
  }
  const windows: WindowResult[] = [];
  let from = windowStart(log.first_live);
  for (let i = 0; i <= MAX_EXTENSIONS; i++) {
    const w = judgeWindow(log, i, from, today);
    windows.push(w);
    if (w.verdict !== "neither") break;
    from = addDays(w.to, 1);
  }
  const last = windows[windows.length - 1];
  const label = last.index === 0 ? "判定期間" : "延長期間";
  if (last.verdict === null) {
    return {
      status: "running",
      first_live: log.first_live,
      windows,
      summary: `${label}中（${last.from}〜${last.to}）。判定は ${addDays(last.to, 1)} 以降に確定します。途中では判定しません。`,
    };
  }
  if (last.verdict === "neither") {
    return {
      status: "owner_call",
      first_live: log.first_live,
      windows,
      summary: "延長期間もどちらの線にも届きませんでした。延長は1回までなので、ここから先はオーナーの判断です。",
    };
  }
  return {
    status: "decided",
    first_live: log.first_live,
    windows,
    summary:
      last.verdict === "continue"
        ? `「続ける」の線に届きました（${last.from}〜${last.to}）。`
        : `「やめる」の線に該当しました（${last.from}〜${last.to}）。ルールの適用であり、努力の評価ではありません。`,
  };
}
