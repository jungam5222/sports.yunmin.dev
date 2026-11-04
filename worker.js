// sports.yunmin.dev 기록 서버.
// 화면(public/)은 정적 파일로 나가고 /api/* 만 이 Worker가 받는다.
// 모든 기록은 Durable Object "League" 하나의 SQLite에 있다 (종목·사람·경기).
// 순위(레이팅)는 저장하지 않고, 화면이 경기 목록을 처음부터 다시 계산한다. 경기를 지우거나 고치면 순위가 저절로 맞춰진다.
//
// 보기는 누구나. 기록·삭제·사람/종목 추가는 공용 비밀번호(PASSCODE, Cloudflare Secret)를 아는 사람만.
// 경기를 지우면 실제로 지우지 않고 deleted_at 만 적어 둔다. 실수로 지운 것을 되살릴 수 있게.
import { DurableObject } from "cloudflare:workers";

const DEFAULT_SPORTS = [
  ["pingpong", "탁구", "🏓"],
  ["badminton", "배드민턴", "🏸"],
  ["tennis", "테니스", "🎾"],
  ["bowling", "볼링", "🎳"],
  ["billiards", "당구", "🎱"],
];
const RESERVED = new Set(["api", "assets", "p", "players", "admin", "index", "favicon"]);
const SLUG = /^[a-z0-9][a-z0-9-]{0,23}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SIDE = 6; // 한 편에 최대 몇 명 (풋살·농구 같은 팀 경기까지)
const MAX_FAILS = 15; // 한 시간에 같은 곳(IP)에서 비밀번호를 틀릴 수 있는 횟수

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const fail = (msg, status = 400) => json({ error: msg }, status);
const clean = (s, max) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export class League extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sports (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sport TEXT NOT NULL, played_on TEXT NOT NULL,
      side_a TEXT NOT NULL, side_b TEXT NOT NULL, score_a INTEGER NOT NULL, score_b INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, deleted_at INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS fails (ip TEXT NOT NULL, hour INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (ip, hour))`);
    if (!this.sql.exec("SELECT 1 FROM sports LIMIT 1").toArray().length) {
      DEFAULT_SPORTS.forEach(([id, name, emoji], i) =>
        this.sql.exec("INSERT INTO sports (id, name, emoji, sort, created_at) VALUES (?, ?, ?, ?, ?)", id, name, emoji, i, Date.now()));
    }
  }

  data() {
    const sports = this.sql.exec("SELECT id, name, emoji FROM sports ORDER BY sort, created_at").toArray();
    const players = this.sql.exec("SELECT id, name FROM players ORDER BY id").toArray();
    const matches = this.sql
      .exec(`SELECT id, sport, played_on AS date, side_a, side_b, score_a AS sa, score_b AS sb, note, created_at AS at
             FROM matches WHERE deleted_at IS NULL ORDER BY played_on, id`)
      .toArray()
      .map(({ side_a, side_b, ...m }) => ({ ...m, a: JSON.parse(side_a), b: JSON.parse(side_b) }));
    return { sports, players, matches };
  }

  // 비밀번호 확인. 틀린 횟수를 IP별로 센다.
  checkPass(ip, given, real) {
    const hour = Math.floor(Date.now() / 3600e3);
    this.sql.exec("DELETE FROM fails WHERE hour < ?", hour - 1);
    const row = this.sql.exec("SELECT n FROM fails WHERE ip = ? AND hour = ?", ip, hour).toArray()[0];
    if (row && row.n >= MAX_FAILS) return "too_many";
    if (given === real) return "ok";
    this.sql.exec(
      "INSERT INTO fails (ip, hour, n) VALUES (?, ?, 1) ON CONFLICT(ip, hour) DO UPDATE SET n = n + 1", ip, hour);
    return "wrong";
  }

  addPlayer(body) {
    const name = clean(body.name, 20);
    if (!name) return { error: "이름을 적어 주세요." };
    if (this.sql.exec("SELECT 1 FROM players WHERE name = ?", name).toArray().length)
      return { error: `'${name}'은(는) 이미 있어요.` };
    if (this.sql.exec("SELECT COUNT(*) AS n FROM players").one().n >= 200) return { error: "사람이 너무 많아요." };
    this.sql.exec("INSERT INTO players (name, created_at) VALUES (?, ?)", name, Date.now());
    return { ok: true };
  }

  addSport(body) {
    const name = clean(body.name, 20);
    const emoji = clean(body.emoji, 8);
    let id = clean(body.id, 24).toLowerCase();
    if (!name) return { error: "종목 이름을 적어 주세요." };
    if (this.sql.exec("SELECT 1 FROM sports WHERE name = ?", name).toArray().length)
      return { error: `'${name}'은(는) 이미 있어요.` };
    if (this.sql.exec("SELECT COUNT(*) AS n FROM sports").one().n >= 40) return { error: "종목이 너무 많아요." };
    if (id) {
      if (!SLUG.test(id) || RESERVED.has(id)) return { error: "주소는 영어 소문자·숫자·- 로만 적어 주세요." };
      if (this.sql.exec("SELECT 1 FROM sports WHERE id = ?", id).toArray().length) return { error: "이미 쓰는 주소예요." };
    } else {
      let n = this.sql.exec("SELECT COUNT(*) AS n FROM sports").one().n + 1;
      while (this.sql.exec("SELECT 1 FROM sports WHERE id = ?", `s${n}`).toArray().length) n++;
      id = `s${n}`;
    }
    const sort = this.sql.exec("SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM sports").one().s;
    this.sql.exec("INSERT INTO sports (id, name, emoji, sort, created_at) VALUES (?, ?, ?, ?, ?)", id, name, emoji, sort, Date.now());
    return { ok: true, id };
  }

  addMatch(body) {
    const sport = String(body.sport ?? "");
    if (!this.sql.exec("SELECT 1 FROM sports WHERE id = ?", sport).toArray().length) return { error: "없는 종목이에요." };
    const date = String(body.date ?? "");
    if (!DATE.test(date) || isNaN(Date.parse(date))) return { error: "날짜가 이상해요." };
    const side = (v) => (Array.isArray(v) ? [...new Set(v.map(Number))].filter(Number.isInteger) : []);
    const a = side(body.a), b = side(body.b);
    if (!a.length || !b.length) return { error: "양쪽 선수를 골라 주세요." };
    if (a.length > MAX_SIDE || b.length > MAX_SIDE) return { error: `한 편에 ${MAX_SIDE}명까지예요.` };
    if (a.some((id) => b.includes(id))) return { error: "같은 사람이 양쪽에 있어요." };
    const known = new Set(this.sql.exec("SELECT id FROM players").toArray().map((r) => r.id));
    if (![...a, ...b].every((id) => known.has(id))) return { error: "없는 사람이 있어요." };
    const sa = Number(body.sa), sb = Number(body.sb);
    const okScore = (n) => Number.isInteger(n) && n >= 0 && n <= 99999;
    if (!okScore(sa) || !okScore(sb)) return { error: "점수는 0 이상의 정수로 적어 주세요." };
    const note = clean(body.note, 120);
    this.sql.exec(
      `INSERT INTO matches (sport, played_on, side_a, side_b, score_a, score_b, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      sport, date, JSON.stringify(a), JSON.stringify(b), sa, sb, note, Date.now());
    return { ok: true };
  }

  deleteMatch(id) {
    const r = this.sql.exec("UPDATE matches SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL", Date.now(), id);
    return r.rowsWritten ? { ok: true } : { error: "없는 경기예요." };
  }

  restoreMatch(id) {
    const r = this.sql.exec("UPDATE matches SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL", id);
    return r.rowsWritten ? { ok: true } : { error: "되살릴 경기가 없어요." };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    const league = env.LEAGUE.get(env.LEAGUE.idFromName("main"));
    const path = url.pathname.slice(4); // "/data", "/matches/3" ...
    const method = request.method;

    if (method === "GET" && path === "/data") return json(await league.data());

    // 여기부터는 고치는 요청: 비밀번호 필요
    if (!["POST", "DELETE"].includes(method)) return fail("지원하지 않는 요청이에요.", 405);
    if (!env.PASSCODE) return fail("아직 비밀번호(PASSCODE)가 설정되지 않아 기록할 수 없어요.", 503);
    const ip = request.headers.get("cf-connecting-ip") || "?";
    const given = request.headers.get("x-pass") || "";
    const check = await league.checkPass(ip, given, env.PASSCODE);
    if (check === "too_many") return fail("비밀번호를 너무 많이 틀렸어요. 한 시간 뒤에 다시 해 주세요.", 429);
    if (check === "wrong") return fail("비밀번호가 맞지 않아요.", 401);

    let body = {};
    if (method === "POST") {
      const text = await request.text();
      if (text) {
        try { body = JSON.parse(text); } catch { return fail("요청 내용을 읽지 못했어요."); }
        if (!body || typeof body !== "object") return fail("요청 내용을 읽지 못했어요.");
      }
    }

    let result;
    let m;
    if (method === "POST" && path === "/login") result = { ok: true };
    else if (method === "POST" && path === "/players") result = await league.addPlayer(body);
    else if (method === "POST" && path === "/sports") result = await league.addSport(body);
    else if (method === "POST" && path === "/matches") result = await league.addMatch(body);
    else if (method === "DELETE" && (m = path.match(/^\/matches\/(\d+)$/))) result = await league.deleteMatch(Number(m[1]));
    else if (method === "POST" && (m = path.match(/^\/matches\/(\d+)\/restore$/))) result = await league.restoreMatch(Number(m[1]));
    else return fail("없는 주소예요.", 404);

    if (result.error) return fail(result.error);
    return json({ ...result, data: await league.data() });
  },
};
