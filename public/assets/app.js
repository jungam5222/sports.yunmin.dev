// sports.yunmin.dev 화면.
// 서버(/api/data)에서 종목·사람·경기를 통째로 받아, 순위는 여기서 경기 순서대로 다시 계산한다.
//   "/"            메인: 종합 순위, 종목별 순위, 최근 경기
//   "/<종목주소>"   종목 페이지: 그 종목 순위, 경기 기록하기, 경기 목록, 맞대결
//   "/p/<번호>"     사람 페이지: 종목별 성적, 상대별 전적
(() => {
  "use strict";

  // ---------- 순위 계산 규칙 ----------
  const START = 1000; // 처음 레이팅
  const kOf = (n) => (n < 10 ? 40 : 24); // 처음 10경기는 크게 움직이고, 그다음은 천천히
  const POINTS = [10, 8, 6, 5, 4, 3, 2, 1]; // 종합 순위: 종목별 등수에 주는 점수 (9등부터는 1점)
  const COLORS = ["#E5483B", "#2F6BDB", "#2E9E5B", "#F2BE22", "#8E5BD6", "#F08A24", "#1FA3A3", "#D94F8C"];

  const $ = (s, el = document) => el.querySelector(s);
  const main = $("#main");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
  };
  const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
  const dow = (d) => WEEK[new Date(d + "T00:00:00").getDay()];
  const shortDate = (d) => `${d.slice(5, 7)}.${d.slice(8, 10)} (${dow(d)})`;
  const today = () => {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  };
  const pct = (w, n) => (n ? Math.round((w / n) * 100) + "%" : "-");

  let DATA = null; // { sports, players, matches }
  let S = null; // 계산 결과

  // ---------- 서버 ----------
  const PASS_KEY = "sports-pass";
  async function api(method, path, body) {
    const res = await fetch("/api" + path, {
      method,
      headers: { "content-type": "application/json", "x-pass": store.get(PASS_KEY) || "" },
      body: body ? JSON.stringify(body) : undefined,
    });
    let out = {};
    try { out = await res.json(); } catch {}
    if (res.status === 401) { store.set(PASS_KEY, null); paintLock(); }
    if (!res.ok) throw Object.assign(new Error(out.error || "요청이 실패했어요."), { status: res.status });
    return out;
  }
  async function load() {
    const cached = store.get("sports-cache");
    if (cached) { try { setData(JSON.parse(cached)); render(); } catch {} }
    try {
      const d = await (await fetch("/api/data", { cache: "no-store" })).json();
      setData(d);
      store.set("sports-cache", JSON.stringify(d));
      render();
    } catch {
      if (!DATA) main.innerHTML = `<div class="loading">기록을 불러오지 못했어요. 잠시 뒤 새로고침해 주세요.</div>`;
    }
  }
  // 고치는 요청: 비밀번호 확인 → 보내기 → 새 데이터로 다시 그리기
  async function mutate(method, path, body) {
    await ensurePass();
    try {
      const out = await api(method, path, body);
      if (out.data) { setData(out.data); store.set("sports-cache", JSON.stringify(out.data)); }
      return out;
    } catch (e) {
      if (e.status === 401) { await ensurePass(); return mutate(method, path, body); }
      throw e;
    }
  }

  // ---------- 계산 ----------
  function setData(d) {
    DATA = d;
    S = compute(d);
  }
  function compute({ sports, players, matches }) {
    const P = new Map(players.map((p) => [p.id, p]));
    const sportIdx = new Map(sports.map((s, i) => [s.id, i]));
    const bySport = new Map(sports.map((s) => [s.id, { sport: s, color: COLORS[sportIdx.get(s.id) % COLORS.length], st: new Map(), matches: [] }]));
    const ordered = [...matches].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.id - y.id));
    for (const m of ordered) {
      const g = bySport.get(m.sport);
      if (!g) continue;
      const st = (id) => {
        if (!g.st.has(id)) g.st.set(id, { id, r: START, n: 0, w: 0, l: 0, d: 0, pf: 0, pa: 0, form: [], last: 0 });
        return g.st.get(id);
      };
      const A = m.a.filter((id) => P.has(id)).map(st), B = m.b.filter((id) => P.has(id)).map(st);
      if (!A.length || !B.length) continue;
      const avg = (xs) => xs.reduce((s, x) => s + x.r, 0) / xs.length;
      const ea = 1 / (1 + 10 ** ((avg(B) - avg(A)) / 400));
      const res = m.sa > m.sb ? 1 : m.sa < m.sb ? 0 : 0.5;
      m.res = res;
      m.delta = {};
      const apply = (xs, score, exp, mine, theirs) => {
        for (const x of xs) {
          const dlt = Math.round(kOf(x.n) * (score - exp));
          x.r += dlt; x.last = dlt; x.n++;
          x.pf += mine; x.pa += theirs;
          const ch = score === 1 ? "W" : score === 0 ? "L" : "D";
          x[ch === "W" ? "w" : ch === "L" ? "l" : "d"]++;
          x.form.push(ch);
          m.delta[x.id] = dlt;
        }
      };
      apply(A, res, ea, m.sa, m.sb);
      apply(B, 1 - res, 1 - ea, m.sb, m.sa);
      g.matches.push(m);
    }
    // 종목별 순위
    for (const g of bySport.values()) {
      g.ranking = [...g.st.values()].sort((x, y) => y.r - x.r || y.w / y.n - x.w / x.n || y.n - x.n);
      let prev = null;
      g.ranking.forEach((x, i) => { x.rank = prev && prev.r === x.r && prev.w === x.w && prev.n === x.n ? prev.rank : i + 1; prev = x; });
    }
    // 종합 순위
    const all = new Map();
    for (const g of bySport.values()) {
      for (const x of g.ranking) {
        if (!all.has(x.id)) all.set(x.id, { id: x.id, pts: 0, n: 0, w: 0, l: 0, d: 0, form: [], ranks: [] });
        const o = all.get(x.id);
        o.pts += POINTS[x.rank - 1] ?? 1;
        o.n += x.n; o.w += x.w; o.l += x.l; o.d += x.d;
        o.ranks.push({ sport: g.sport, rank: x.rank, color: g.color });
      }
    }
    const recentAll = [...matches].sort((x, y) => (x.date > y.date ? -1 : x.date < y.date ? 1 : y.id - x.id));
    for (const m of [...recentAll].reverse()) {
      for (const id of [...m.a, ...m.b]) {
        const o = all.get(id);
        if (o) o.form.push(m.res === 0.5 ? "D" : (m.res === 1) === m.a.includes(id) ? "W" : "L");
      }
    }
    const overall = [...all.values()].sort((x, y) => y.pts - x.pts || y.w - x.w || y.w / y.n - x.w / x.n);
    let prev = null;
    overall.forEach((x, i) => { x.rank = prev && prev.pts === x.pts && prev.w === x.w && prev.n === x.n ? prev.rank : i + 1; prev = x; });
    return { P, bySport, overall, recent: recentAll };
  }

  // ---------- 조각 ----------
  const name = (id) => S.P.get(id)?.name ?? "?";
  const plink = (id) => `<a href="/p/${id}">${esc(name(id))}</a>`;
  const pos = (r) => `<span class="pos${r <= 3 ? " p" + r : ""}">${r}</span>`;
  const wl = (x) => `<span class="wl mono"><b>${x.w}</b>승 <s>${x.l}</s>패${x.d ? ` ${x.d}무` : ""}</span>`;
  const form = (f) => `<span class="form" aria-label="최근 경기 ${f.slice(-5).join(" ")}">${f.slice(-5).map((c) => `<i class="${c}"></i>`).join("")}</span>`;
  const sportOf = (id) => S.bySport.get(id);
  const setLine = (m) => (m.sets || []).map(([x, y]) => `<span class="${x > y ? "sw" : ""}">${x}</span>-<span class="${y > x ? "sw" : ""}">${y}</span>`).join(" · ");
  const gameRow = (m, { showSport = false, canDelete = false, byDay = false } = {}) => {
    const aWin = m.sa > m.sb, bWin = m.sb > m.sa;
    const g = sportOf(m.sport);
    const side = (ids, cls) => `<div class="side ${cls}">${ids.map(plink).join(", ")}</div>`;
    return `<li>
      <div class="date">${showSport && g ? `<a href="/${esc(g.sport.id)}">${esc(g.sport.emoji)} ${esc(g.sport.name)}</a><br>` : ""}${byDay ? "" : shortDate(m.date)}</div>
      ${side(m.a, "a" + (aWin ? " win" : ""))}
      <div class="score"><span class="${aWin ? "w" : bWin ? "l" : ""}">${m.sa}</span> : <span class="${bWin ? "w" : aWin ? "l" : ""}">${m.sb}</span></div>
      ${side(m.b, "b" + (bWin ? " win" : ""))}
      <div class="act">${canDelete ? `<button class="x" data-del="${m.id}" aria-label="이 경기 지우기" title="지우기">✕</button>` : ""}</div>
      ${m.sets?.length ? `<div class="note sets-line">${setLine(m)}</div>` : ""}
      ${m.note ? `<div class="note">${esc(m.note)}</div>` : ""}
    </li>`;
  };
  const gameList = (list, opts = {}, limit = 15) => {
    if (!list.length) return `<div class="empty">아직 기록된 경기가 없어요.</div>`;
    const shown = list.slice(0, limit);
    let html = "", day = null, open = false;
    for (const m of shown) {
      if (opts.byDay && m.date !== day) {
        if (open) html += `</ul>`;
        day = m.date;
        html += `<div class="day-head">${m.date.replace(/-/g, ".")} ${dow(m.date)}요일</div><ul class="games">`;
        open = true;
      } else if (!open) { html += `<ul class="games">`; open = true; }
      html += gameRow(m, opts);
    }
    if (open) html += `</ul>`;
    if (list.length > limit) html += `<button class="more" data-more="${limit + 30}">경기 ${list.length - limit}개 더 보기</button>`;
    return html;
  };

  // ---------- 메인 ----------
  function renderHome() {
    document.title = "누가 제일 잘해? · sports.yunmin.dev";
    const { sports, players, matches } = DATA;
    const latest = [...matches].sort((x, y) => y.at - x.at)[0];
    const board = (() => {
      if (!latest) return `<div class="board idle"><div class="board-top"><span>SCOREBOARD</span><span>대기 중</span></div>
        <div class="board-row"><div class="board-side"><div class="board-names">HOME</div></div><div class="board-score">0<i>:</i>0</div><div class="board-side"><div class="board-names">AWAY</div></div></div>
        <div class="board-foot"><span>첫 경기를 기다리는 중</span><span>아래에서 종목을 골라 기록해요</span></div></div>`;
      const g = sportOf(latest.sport);
      const aW = latest.sa > latest.sb, bW = latest.sb > latest.sa;
      return `<div class="board"><div class="board-top"><span class="live">LATEST</span><span>${esc(g?.sport.emoji)} ${esc(g?.sport.name)} · ${shortDate(latest.date)}</span></div>
        <div class="board-row">
          <div class="board-side${aW ? " win" : ""}"><div class="board-names">${latest.a.map((i) => esc(name(i))).join("<br>")}</div></div>
          <div class="board-score"><span class="${aW ? "w" : ""}">${latest.sa}</span><i>:</i><span class="${bW ? "w" : ""}">${latest.sb}</span></div>
          <div class="board-side${bW ? " win" : ""}"><div class="board-names">${latest.b.map((i) => esc(name(i))).join("<br>")}</div></div>
        </div>
        <div class="board-foot"><span>${latest.sets?.length ? `<span class="mono">${setLine(latest)}</span>` : latest.note ? esc(latest.note) : "방금 올라온 경기"}</span><a href="/${esc(latest.sport)}">${esc(g?.sport.name)} 순위 →</a></div></div>`;
    })();

    const overall = S.overall.length
      ? `<div class="panel table-wrap"><table class="rank">
          <thead><tr><th>#</th><th>이름</th><th class="num">종합점수</th><th>종목별 순위</th><th class="num hide-m">전적</th><th class="num hide-m">승률</th><th class="hide-m">최근</th></tr></thead>
          <tbody>${S.overall.map((x) => `<tr>
            <td>${pos(x.rank)}</td>
            <td class="name">${plink(x.id)}<span class="sub">${x.w}승 ${x.l}패${x.d ? ` ${x.d}무` : ""}</span></td>
            <td class="num big">${x.pts}</td>
            <td><div class="sport-ranks">${x.ranks.sort((p, q) => p.rank - q.rank).map((r) => `<span class="chip" title="${esc(r.sport.name)} ${r.rank}위">${esc(r.sport.emoji || r.sport.name)} <b>${r.rank}</b></span>`).join("")}</div></td>
            <td class="num hide-m">${wl(x)}</td>
            <td class="num hide-m">${pct(x.w, x.n)}</td>
            <td class="hide-m">${form(x.form)}</td>
          </tr>`).join("")}</tbody></table>
          <p class="rule">종합점수: 종목마다 1위 10점, 2위 8점, 3위 6점, 4위 5점 … 8위 1점, 그 아래도 참가하면 1점. 여러 종목을 잘할수록 높아요.</p></div>`
      : `<div class="panel"><div class="empty">아직 경기가 없어요. <b>아래에서 종목을 골라</b> 첫 경기를 기록해 보세요.</div></div>`;

    const cards = sports.map((s) => {
      const g = sportOf(s.id);
      const top = g.ranking.slice(0, 3);
      return `<a class="sport-card" href="/${esc(s.id)}" style="--c:${g.color}">
        <div class="sport-card-head"><span class="emo">${esc(s.emoji)}</span><h3>${esc(s.name)}</h3><span class="count">${g.matches.length}경기</span></div>
        <ol class="podium">${top.length ? top.map((x) => `<li>${pos(x.rank)}<span>${esc(name(x.id))}</span><span class="r">${x.r}</span></li>`).join("") : `<li class="none">아직 경기가 없어요</li>`}</ol>
        <div class="go"><span>${g.ranking.length ? `${g.ranking.length}명 참가` : "첫 경기 기록하기"}</span><span>→</span></div>
      </a>`;
    }).join("");

    main.innerHTML = `<div class="wrap">
      <section class="hero">
        <div>
          <div class="hero-meta"><span>${matches.length}경기 기록됨</span><span>${sports.length}개 종목</span><span>${players.length}명</span></div>
          <h1>누가 제일<br>잘하나 보자<span class="dot">.</span></h1>
          <p class="lead">같이 운동한 경기 결과를 남기면, 종목별 순위와 종합 순위가 저절로 매겨져요. 종목을 눌러 경기를 기록해 보세요.</p>
        </div>
        ${board}
      </section>

      <section class="sec">
        <div class="sec-head"><h2>🏆 종합 순위</h2><span class="muted">모든 종목을 합쳐서</span></div>
        ${overall}
      </section>

      <section class="sec">
        <div class="sec-head"><h2>종목별 순위</h2><span class="muted">카드를 누르면 기록하고 자세히 볼 수 있어요</span></div>
        <div class="sport-grid">${cards}<button class="add-card" id="add-sport" type="button"><span>＋</span>종목 추가</button></div>
      </section>

      <section class="sec">
        <div class="sec-head"><h2>최근 경기</h2></div>
        <div class="panel" id="recent">${gameList(S.recent, { showSport: true }, 8)}</div>
      </section>
    </div>`;
    $("#add-sport").onclick = addSportDialog;
    bindMore($("#recent"), (n) => gameList(S.recent, { showSport: true }, n));
  }

  // ---------- 종목 페이지 ----------
  const form$ = { sport: null, picks: [] };
  function renderSport(g) {
    const s = g.sport;
    document.title = `${s.name} 순위 · sports.yunmin.dev`;
    if (form$.sport !== s.id) { form$.sport = s.id; form$.picks = []; }
    const list = [...g.matches].reverse();
    const last = list[0];
    const unlocked = !!store.get(PASS_KEY);

    const ranking = g.ranking.length
      ? `<div class="panel table-wrap"><table class="rank">
          <thead><tr><th>#</th><th>이름</th><th class="num">레이팅</th><th class="num">전적</th><th class="num hide-m">승률</th><th class="num hide-m">득실</th><th class="hide-m">최근</th></tr></thead>
          <tbody>${g.ranking.map((x) => `<tr>
            <td>${pos(x.rank)}</td>
            <td class="name">${plink(x.id)}</td>
            <td class="num"><span class="big">${x.r}</span>${x.last ? `<span class="delta ${x.last > 0 ? "up" : "down"}">${x.last > 0 ? "▲" : "▼"}${Math.abs(x.last)}</span>` : ""}</td>
            <td class="num">${wl(x)}</td>
            <td class="num hide-m">${pct(x.w, x.n)}</td>
            <td class="num hide-m">${x.pf - x.pa > 0 ? "+" : ""}${x.pf - x.pa}</td>
            <td class="hide-m">${form(x.form)}</td>
          </tr>`).join("")}</tbody></table>
          <p class="rule">레이팅: 모두 1000점에서 시작. 이기면 오르고 지면 내려가요. 강한 상대를 이기면 더 많이 오르고, 약한 상대에게 지면 더 많이 내려가요 (Elo 방식). 득실은 이긴 세트 − 진 세트.</p></div>`
      : `<div class="panel"><div class="empty">아직 ${esc(s.name)} 경기가 없어요. 첫 경기를 기록해 보세요.</div></div>`;

    // 단식 맞대결 표
    const singles = g.matches.filter((m) => m.a.length === 1 && m.b.length === 1);
    const ids = g.ranking.map((x) => x.id).filter((id) => singles.some((m) => m.a[0] === id || m.b[0] === id)).slice(0, 10);
    let h2h = "";
    if (ids.length >= 2) {
      const rec = (p, q) => {
        let w = 0, l = 0;
        for (const m of singles) {
          if (m.a[0] === p && m.b[0] === q) { if (m.sa > m.sb) w++; else if (m.sa < m.sb) l++; }
          if (m.b[0] === p && m.a[0] === q) { if (m.sb > m.sa) w++; else if (m.sb < m.sa) l++; }
        }
        return [w, l];
      };
      h2h = `<section class="sec"><div class="sec-head"><h2>맞대결</h2><span class="muted">왼쪽 사람 기준 승-패</span></div>
        <div class="panel table-wrap"><table class="h2h"><thead><tr><th></th>${ids.map((q) => `<th>${esc(name(q))}</th>`).join("")}</tr></thead>
        <tbody>${ids.map((p) => `<tr><th>${plink(p)}</th>${ids.map((q) => {
          if (p === q) return `<td class="self"></td>`;
          const [w, l] = rec(p, q);
          return `<td class="${w + l === 0 ? "muted" : w > l ? "good" : w < l ? "bad" : ""}">${w + l ? `${w}-${l}` : "·"}</td>`;
        }).join("")}</tr>`).join("")}</tbody></table></div></section>`;
    }

    main.innerHTML = `<div class="wrap" style="--c:${g.color}">
      <section class="page-head">
        <a class="back" href="/">← 전체 순위</a>
        <h1><span class="emo">${esc(s.emoji)}</span>${esc(s.name)}</h1>
        <p class="lead">${g.matches.length ? `${g.matches.length}경기 · ${g.ranking.length}명 참가 · 마지막 경기 ${shortDate(last.date)}` : "아직 경기가 없어요"}</p>
        <div class="bar"></div>
        <nav class="sport-tabs" aria-label="종목">${DATA.sports.map((x) => `<a href="/${esc(x.id)}"${x.id === s.id ? ' aria-current="page"' : ""}>${esc(x.emoji)} ${esc(x.name)}</a>`).join("")}</nav>
      </section>
      <div class="split sec" style="margin-top:24px">
        <div>
          <div class="sec-head"><h2>순위</h2></div>
          ${ranking}
          <section class="sec">
            <div class="sec-head"><h2>경기 기록</h2>${unlocked ? `<span class="muted">✕ 를 누르면 지울 수 있어요</span>` : ""}</div>
            <div class="panel" id="games">${gameList(list, { byDay: true, canDelete: unlocked }, 20)}</div>
          </section>
          ${h2h}
        </div>
        <aside class="panel panel-pad rec" id="rec"></aside>
      </div>
    </div>`;
    renderForm(g);
    bindMore($("#games"), (n) => gameList(list, { byDay: true, canDelete: unlocked }, n));
    $("#games").addEventListener("click", (e) => {
      const b = e.target.closest("[data-del]");
      if (b) deleteMatch(Number(b.dataset.del));
    });
  }

  // 두 사람을 고르고, 세트 스코어를 적고, 그 아래에 세트마다 점수를 적는다.
  // 세트 점수 칸 수 = 세트 스코어의 합. 세트 점수는 비워 두거나(세트 스코어만 기록) 모두 채운다.
  const MAX_SETS = 9;
  function renderForm(g, keep = {}) {
    const el = $("#rec");
    const counts = new Map(g.ranking.map((x) => [x.id, x.n]));
    const ps = [...DATA.players].sort((x, y) => (counts.get(y.id) || 0) - (counts.get(x.id) || 0) || x.name.localeCompare(y.name, "ko"));
    const [p1, p2] = form$.picks;
    const chips = ps.length
      ? ps.map((p) => {
          const i = form$.picks.indexOf(p.id);
          return `<button type="button" class="pick${i >= 0 ? " on" + (i + 1) : ""}" data-id="${p.id}" aria-pressed="${i >= 0}">${i >= 0 ? `<i>${i + 1}</i>` : ""}${esc(p.name)}</button>`;
        }).join("")
      : `<span class="muted" style="font-size:13px">아래에서 사람을 먼저 추가해 주세요</span>`;
    const label = (id, n) => (id ? esc(name(id)) : `선수 ${n}`);
    el.innerHTML = `<h2>경기 기록하기 <span class="chip">${esc(g.sport.emoji)} ${esc(g.sport.name)}</span></h2>
      <div class="field">
        <span class="label">누가 붙었나요? <span class="muted" style="font-weight:400">두 명을 골라 주세요</span></span>
        <div class="picks one">${chips}</div>
        <form class="add-player" id="add-player"><input class="in" name="name" maxlength="20" placeholder="새 사람 이름 (예: 홍윤민)" autocomplete="off"><button class="btn small ghost" type="submit">＋ 추가</button></form>
      </div>
      <div class="field">
        <span class="label">세트 스코어</span>
        <div class="scores">
          <div class="who w1">${label(p1, 1)}</div><span></span><div class="who w2">${label(p2, 2)}</div>
          <input class="in" id="sa" type="number" inputmode="numeric" min="0" max="${MAX_SETS}" placeholder="0" value="${esc(keep.sa ?? "")}" aria-label="${label(p1, 1)} 세트 스코어">
          <span>:</span>
          <input class="in" id="sb" type="number" inputmode="numeric" min="0" max="${MAX_SETS}" placeholder="0" value="${esc(keep.sb ?? "")}" aria-label="${label(p2, 2)} 세트 스코어">
        </div>
      </div>
      <div class="field" id="sets-field" hidden>
        <span class="label">세트별 점수 <span class="muted" style="font-weight:400">(선택)</span></span>
        <div class="sets" id="sets"></div>
      </div>
      <div class="field row2">
        <div><label for="date">날짜</label><input class="in" id="date" type="date" value="${esc(keep.date || today())}" max="${today()}"></div>
        <div><label for="note">메모 <span class="muted" style="font-weight:400">(선택)</span></label><input class="in" id="note" maxlength="120" placeholder="예: 마지막 세트 듀스" value="${esc(keep.note || "")}"></div>
      </div>
      <p class="verdict" id="verdict"></p>
      <button class="btn primary" id="save" type="button">기록하기</button>
      <p class="msg" id="msg"></p>`;

    const num = (v) => (v === "" ? null : Number(v));
    const readSets = () => [...el.querySelectorAll(".set-row")].map((r) => [num(r.querySelector(".x1").value), num(r.querySelector(".x2").value)]);
    let setVals = keep.sets || [];
    const drawSets = () => {
      const n = (Number($("#sa").value) || 0) + (Number($("#sb").value) || 0);
      const box = $("#sets");
      if (box.children.length) setVals = readSets();
      $("#sets-field").hidden = !(n > 0 && n <= MAX_SETS);
      if (n === box.children.length) return;
      box.innerHTML = Array.from({ length: n > MAX_SETS ? 0 : n }, (_, i) => {
        const [x, y] = setVals[i] || [null, null];
        return `<div class="set-row"><span class="set-no">${i + 1}세트</span>
          <input class="in x1" type="number" inputmode="numeric" min="0" max="9999" value="${x ?? ""}" aria-label="${i + 1}세트 ${label(p1, 1)} 점수">
          <span>:</span>
          <input class="in x2" type="number" inputmode="numeric" min="0" max="9999" value="${y ?? ""}" aria-label="${i + 1}세트 ${label(p2, 2)} 점수"></div>`;
      }).join("");
    };
    // 세트 점수 검사: 모두 비었으면 null, 다 찼으면 배열, 아니면 오류 문구
    const checkSets = (sa, sb) => {
      const rows = readSets();
      if (!rows.length || rows.every(([x, y]) => x == null && y == null)) return { sets: null };
      if (rows.some(([x, y]) => x == null || y == null)) return { error: "세트 점수를 모두 채우거나 모두 비워 주세요" };
      const w1 = rows.filter(([x, y]) => x > y).length, w2 = rows.filter(([x, y]) => y > x).length;
      if (w1 !== sa || w2 !== sb) return { error: `세트 점수대로면 ${w1} : ${w2}인데 세트 스코어는 ${sa} : ${sb}예요` };
      return { sets: rows };
    };
    const verdict = () => {
      drawSets();
      const sa = $("#sa").value, sb = $("#sb").value;
      const v = $("#verdict");
      let ok = false;
      if (form$.picks.length < 2) v.innerHTML = `<span class="muted">두 사람을 골라 주세요</span>`;
      else if (sa === "" || sb === "") v.innerHTML = `<b>${esc(name(p1))}</b> vs <b>${esc(name(p2))}</b>`;
      else if (+sa + +sb > MAX_SETS) v.innerHTML = `<span class="err">세트는 모두 ${MAX_SETS}개까지예요</span>`;
      else {
        const c = checkSets(+sa, +sb);
        if (c.error) v.innerHTML = `<span class="err">${esc(c.error)}</span>`;
        else {
          ok = true;
          v.innerHTML = +sa === +sb ? `<b>${esc(name(p1))}</b> ${sa} : ${sb} <b>${esc(name(p2))}</b> · 무승부`
            : `<b>${esc(name(+sa > +sb ? p1 : p2))}</b> 승리 (${Math.max(sa, sb)} : ${Math.min(sa, sb)})`;
        }
      }
      $("#save").disabled = !ok;
    };
    const snapshot = () => ({ sa: $("#sa").value, sb: $("#sb").value, date: $("#date").value, note: $("#note").value, sets: readSets() });
    el.querySelectorAll(".pick").forEach((b) => (b.onclick = () => {
      const id = Number(b.dataset.id), i = form$.picks.indexOf(id);
      if (i >= 0) form$.picks.splice(i, 1);
      else if (form$.picks.length < 2) form$.picks.push(id);
      else form$.picks[1] = id; // 이미 두 명이면 두 번째 사람을 바꾼다
      renderForm(g, snapshot());
    }));
    el.oninput = verdict;
    verdict();
    const msg = (t, cls) => { const m = $("#msg"); m.textContent = t; m.className = "msg " + (cls || ""); };

    $("#add-player").onsubmit = async (e) => {
      e.preventDefault();
      const nm = e.target.name.value.trim();
      if (!nm) return;
      const keepNow = snapshot();
      try {
        await mutate("POST", "/players", { name: nm });
        const p = DATA.players.find((x) => x.name === nm);
        if (p && form$.picks.length < 2) form$.picks.push(p.id);
        renderForm(sportOf(g.sport.id), keepNow);
        toast(`${nm} 님을 추가했어요`);
      } catch (err) { if (err.message !== "cancel") msg(err.message, "err"); }
    };

    $("#save").onclick = async () => {
      const sa = Number($("#sa").value), sb = Number($("#sb").value);
      const c = checkSets(sa, sb);
      if (c.error) return msg(c.error, "err");
      const body = { sport: g.sport.id, a: [p1], b: [p2], sa, sb, sets: c.sets || [], date: $("#date").value, note: $("#note").value };
      $("#save").disabled = true;
      try {
        await mutate("POST", "/matches", body);
        render({ date: body.date });
        toast("경기를 기록했어요");
      } catch (err) {
        $("#save").disabled = false;
        if (err.message !== "cancel") msg(err.message, "err");
      }
    };
  }

  async function deleteMatch(id) {
    try {
      await mutate("DELETE", `/matches/${id}`);
      render();
      toast("경기를 지웠어요", "되돌리기", async () => {
        try { await mutate("POST", `/matches/${id}/restore`); render(); toast("되살렸어요"); } catch (e) { toast(e.message); }
      });
    } catch (e) { if (e.message !== "cancel") toast(e.message); }
  }

  // ---------- 사람 페이지 ----------
  function renderPlayer(id) {
    const p = S.P.get(id);
    if (!p) return renderMissing();
    document.title = `${p.name} · sports.yunmin.dev`;
    const o = S.overall.find((x) => x.id === id);
    const mine = S.recent.filter((m) => m.a.includes(id) || m.b.includes(id));
    const rows = [...S.bySport.values()].map((g) => ({ g, x: g.st.get(id) })).filter((r) => r.x).sort((a, b) => a.x.rank - b.x.rank);
    // 상대별 전적 (같이 뛴 사람 말고, 맞은편에 있던 사람)
    const vs = new Map();
    for (const m of mine) {
      const inA = m.a.includes(id);
      const opp = inA ? m.b : m.a;
      const r = m.res === 0.5 ? "d" : (m.res === 1) === inA ? "w" : "l";
      for (const q of opp) {
        if (!vs.has(q)) vs.set(q, { w: 0, l: 0, d: 0, n: 0 });
        const v = vs.get(q); v[r]++; v.n++;
      }
    }
    const rivals = [...vs.entries()].sort((a, b) => b[1].n - a[1].n);
    main.innerHTML = `<div class="wrap">
      <section class="page-head">
        <a class="back" href="/">← 전체 순위</a>
        <h1>${esc(p.name)}</h1>
        <p class="lead">${o ? `종합 ${o.rank}위 · ${o.pts}점` : "아직 경기 기록이 없어요"}</p>
        <div class="stats">
          <div class="stat" style="--c:var(--gold)"><div class="k">종합 순위</div><div class="v">${o ? o.rank + "위" : "-"}</div></div>
          <div class="stat" style="--c:var(--blue)"><div class="k">경기</div><div class="v">${o?.n ?? 0}</div></div>
          <div class="stat" style="--c:var(--green)"><div class="k">전적</div><div class="v">${o ? `${o.w}승 ${o.l}패` : "-"}</div></div>
          <div class="stat" style="--c:var(--red)"><div class="k">승률</div><div class="v">${o ? pct(o.w, o.n) : "-"}</div></div>
        </div>
      </section>
      ${rows.length ? `<section class="sec"><div class="sec-head"><h2>종목별 성적</h2></div>
        <div class="panel table-wrap"><table class="rank"><thead><tr><th>#</th><th>종목</th><th class="num">레이팅</th><th class="num">전적</th><th class="num hide-m">승률</th><th class="hide-m">최근</th></tr></thead>
        <tbody>${rows.map(({ g, x }) => `<tr><td>${pos(x.rank)}</td><td class="name"><a href="/${esc(g.sport.id)}">${esc(g.sport.emoji)} ${esc(g.sport.name)}</a> <span class="muted" style="font-size:13px">/ ${g.ranking.length}명</span></td>
          <td class="num big">${x.r}</td><td class="num">${wl(x)}</td><td class="num hide-m">${pct(x.w, x.n)}</td><td class="hide-m">${form(x.form)}</td></tr>`).join("")}</tbody></table></div></section>` : ""}
      ${rivals.length ? `<section class="sec"><div class="sec-head"><h2>상대별 전적</h2><span class="muted">모든 종목, 맞은편에서 만난 횟수 순</span></div>
        <div class="panel table-wrap"><table class="rank"><thead><tr><th>vs</th><th>상대</th><th class="num">만남</th><th class="num">전적</th><th class="num">승률</th></tr></thead>
        <tbody>${rivals.map(([q, v]) => `<tr><td><span class="pos">${v.w > v.l ? "😎" : v.w < v.l ? "😤" : "🤝"}</span></td><td class="name">${plink(q)}</td><td class="num">${v.n}</td><td class="num">${wl(v)}</td><td class="num">${pct(v.w, v.n)}</td></tr>`).join("")}</tbody></table></div></section>` : ""}
      <section class="sec"><div class="sec-head"><h2>최근 경기</h2></div><div class="panel" id="pgames">${gameList(mine, { showSport: true }, 15)}</div></section>
    </div>`;
    bindMore($("#pgames"), (n) => gameList(mine, { showSport: true }, n));
  }

  function renderMissing() {
    document.title = "없는 페이지 · sports.yunmin.dev";
    main.innerHTML = `<div class="wrap"><section class="page-head"><a class="back" href="/">← 전체 순위</a><h1>여기는 빈 코트예요</h1>
      <p class="lead">주소에 맞는 종목이나 사람이 없어요.</p><p style="margin-top:20px"><a class="btn primary" href="/">메인으로</a></p></section></div>`;
  }

  // ---------- 공통 동작 ----------
  function bindMore(box, make) {
    box.addEventListener("click", (e) => {
      const b = e.target.closest("[data-more]");
      if (b) box.innerHTML = make(Number(b.dataset.more));
    });
  }

  let toastTimer;
  function toast(text, action, fn) {
    const t = $("#toast");
    t.innerHTML = `<span>${esc(text)}</span>${action ? `<button type="button">${esc(action)}</button>` : ""}`;
    if (action) t.querySelector("button").onclick = () => { t.classList.remove("show"); fn(); };
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), action ? 6000 : 2600);
  }

  function openDialog(html, onSubmit, dlg = $("#dlg")) {
    return new Promise((resolve, reject) => {
      dlg.innerHTML = `<form method="dialog">${html}<p class="msg err" data-err></p>
        <div class="actions"><button class="btn ghost small" value="cancel" type="button" data-cancel>취소</button><button class="btn primary small" type="submit">확인</button></div></form>`;
      const f = dlg.querySelector("form");
      let done = false;
      dlg.querySelector("[data-cancel]").onclick = () => dlg.close();
      dlg.onclose = () => { if (!done) reject(new Error("cancel")); };
      f.onsubmit = async (e) => {
        e.preventDefault();
        try { const r = await onSubmit(f); done = true; dlg.close(); resolve(r); }
        catch (err) { dlg.querySelector("[data-err]").textContent = err.message; }
      };
      dlg.showModal();
      f.querySelector("input")?.focus();
    });
  }

  function ensurePass() {
    if (store.get(PASS_KEY)) return Promise.resolve();
    return openDialog(`<h3>🔒 기록 잠금 해제</h3><p>기록하거나 지우려면 같이 운동하는 사람들끼리 정한 비밀번호가 필요해요. 한 번 넣으면 이 기기에서는 기억해요.</p>
      <div class="field"><input class="in" name="pass" type="password" autocomplete="current-password" placeholder="비밀번호" required></div>`,
      async (f) => {
        const pass = f.pass.value;
        const res = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json", "x-pass": pass }, body: "{}" });
        if (!res.ok) { let m = "비밀번호가 맞지 않아요."; try { m = (await res.json()).error || m; } catch {} throw new Error(m); }
        store.set(PASS_KEY, pass);
        paintLock();
        render();
      }, $("#dlg-pass"));
  }

  function paintLock() {
    const b = $("#lock");
    const on = !!store.get(PASS_KEY);
    b.className = "lock" + (on ? " on" : "");
    b.innerHTML = on ? `🔓 <span class="t">기록 가능</span>` : `🔒 <span class="t">기록 잠김</span>`;
    b.title = on ? "이 기기에서 비밀번호 지우기" : "비밀번호를 넣고 기록 잠금 풀기";
  }
  $("#lock").onclick = () => {
    if (store.get(PASS_KEY)) {
      if (confirm("이 기기에서 비밀번호를 지울까요? 다시 기록하려면 또 넣어야 해요.")) { store.set(PASS_KEY, null); paintLock(); render(); }
    } else ensurePass().catch(() => {});
  };

  async function addSportDialog() {
    try { await ensurePass(); } catch { return; }
    openDialog(`<h3>종목 추가</h3><p>새로 같이 하는 운동이 생겼나요?</p>
      <div class="field"><label for="sp-name">이름</label><input class="in" id="sp-name" name="sname" maxlength="20" placeholder="예: 풋살" required></div>
      <div class="field row2"><div><label for="sp-emo">이모지</label><input class="in" id="sp-emo" name="emoji" maxlength="8" placeholder="⚽"></div>
      <div><label for="sp-id">주소 <span class="muted" style="font-weight:400">(선택, 영어)</span></label><input class="in" id="sp-id" name="sid" maxlength="24" placeholder="futsal" pattern="[a-z0-9][a-z0-9\\-]*"></div></div>`,
      async (f) => {
        const out = await mutate("POST", "/sports", { name: f.sname.value, emoji: f.emoji.value, id: f.sid.value });
        return out.id;
      }).then((id) => { location.href = "/" + id; }).catch(() => {});
  }

  // ---------- 길 찾기 ----------
  function render(keep) {
    if (!DATA) return;
    const path = decodeURIComponent(location.pathname).replace(/\/+$/, "") || "/";
    let m;
    if (path === "/") renderHome();
    else if ((m = path.match(/^\/p\/(\d+)$/))) renderPlayer(Number(m[1]));
    else if ((m = path.match(/^\/([a-z0-9-]+)$/)) && sportOf(m[1])) {
      const snap = keep ? { date: keep.date } : undefined;
      renderSport(sportOf(m[1]));
      if (snap) renderForm(sportOf(m[1]), snap);
    } else renderMissing();
  }

  paintLock();
  load();
})();
