(function () {
  'use strict';

  /* =========================================================
     CONFIG
     ========================================================= */
  const SUPABASE_URL = 'https://dvctnhmerpuuzxmawxwz.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_OjUhXapGim0eeHOomfcbpw_ObN0jpsl';
  const TEAMS_COUNT  = 16;
  const MATCHES_PER_TEAM = 8;
  const ADMIN_CODE   = 'altasigmaemirloh';

  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  /* =========================================================
     IN-MEMORY STATE (loaded from Supabase)
     ========================================================= */
  let teams    = [];   // [{id, name, sort_order}]
  let matches  = [];   // [{id, match_type, slot, round, home_id, away_id, home_goals, away_goals, played}]
  let settings = {};   // {seed: '...'}
  let isAdmin  = sessionStorage.getItem('nml_admin') === '1';
  let customTable = null; // загруженная вручную таблица [{name, p, w, d, l, gs, gc, pts}]

  /* =========================================================
     BOOTSTRAP
     ========================================================= */
  document.addEventListener('DOMContentLoaded', async () => {
    initTabs();
    initAdmin();
    initModal();
    initAuth();
    applyAdminMode();
    await loadAll();
    subscribeRealtime();
    document.getElementById('loading').style.display = 'none';
    document.getElementById('app').style.display = '';
  });

  /* =========================================================
     DATA — load everything from Supabase
     ========================================================= */
  async function loadAll() {
    const [tRes, mRes, sRes] = await Promise.all([
      db.from('teams').select('*').order('sort_order'),
      db.from('matches').select('*').order('id'),
      db.from('settings').select('*'),
    ]);

    if (tRes.error || mRes.error || sRes.error) {
      console.error('Load error', tRes.error, mRes.error, sRes.error);
      toast('Ошибка загрузки данных');
      document.getElementById('loading').style.display = 'none';
      document.getElementById('app').style.display = '';
      return;
    }

    teams    = tRes.data || [];
    matches  = mRes.data || [];
    settings = {};
    (sRes.data || []).forEach(r => { settings[r.key] = r.value; });

    // Restore custom table from settings
    if (settings.custom_table) {
      try { customTable = JSON.parse(settings.custom_table); } catch { customTable = null; }
    } else {
      customTable = null;
    }

    render();
  }

  /* =========================================================
     REALTIME — auto-refresh when another user edits
     ========================================================= */
  let reloadTimer;
  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(loadAll, 600);
  }

  function subscribeRealtime() {
    db.channel('nml-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, scheduleReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'teams' },   scheduleReload)
      .subscribe();
  }

  /* =========================================================
     RENDER — everything
     ========================================================= */
  function render() {
    renderStats();
    renderTable();
    renderMatches();
    renderPlayoff();
    renderAdmin();
  }

  /* ---------- Stats bar ---------- */
  function renderStats() {
    const group   = matches.filter(m => m.match_type === 'group');
    const played  = group.filter(m => m.played).length;
    const total   = group.length;
    const goals   = group.filter(m => m.played).reduce((s, m) => s + (m.home_goals||0) + (m.away_goals||0), 0);
    document.getElementById('statTeams').textContent     = teams.length;
    document.getElementById('statPlayed').textContent    = played;
    document.getElementById('statGoals').textContent     = goals;
    document.getElementById('statRemaining').textContent = Math.max(0, total - played);
  }

  /* ---------- League table ---------- */
  function getStandings() {
    const map = {};
    teams.forEach(t => {
      map[t.id] = { id: t.id, name: t.name, p:0, w:0, d:0, l:0, gs:0, gc:0, gd:0, pts:0 };
    });
    matches.filter(m => m.match_type === 'group' && m.played).forEach(m => {
      const h = map[m.home_id], a = map[m.away_id];
      if (!h || !a) return;
      h.p++; a.p++;
      h.gs += m.home_goals; h.gc += m.away_goals;
      a.gs += m.away_goals; a.gc += m.home_goals;
      h.gd = h.gs - h.gc;  a.gd = a.gs - a.gc;
      if (m.home_goals > m.away_goals)      { h.w++; h.pts += 3; a.l++; }
      else if (m.home_goals < m.away_goals) { a.w++; a.pts += 3; h.l++; }
      else                                  { h.d++; h.pts++;    a.d++; a.pts++; }
    });
    return Object.values(map).sort((a, b) =>
      b.pts - a.pts || b.gd - a.gd || b.gs - a.gs || a.name.localeCompare(b.name)
    );
  }

  function renderTable() {
    const st = customTable || getStandings();
    document.getElementById('tableBody').innerHTML = st.map((r, i) => {
      const pos = i + 1;
      const cls = pos <= 6 ? 'zone-playoff-row' : pos <= 10 ? 'zone-qual-row' : 'zone-out-row';
      const gd  = (r.gd != null ? r.gd : r.gs - r.gc);
      const gdStr = gd > 0 ? '+' + gd : gd;
      return `<tr class="${cls}">
        <td class="col-pos">${pos}</td><td class="col-team">${esc(r.name)}</td>
        <td>${r.p}</td><td>${r.w}</td><td>${r.d}</td><td>${r.l}</td>
        <td>${r.gs}</td><td>${r.gc}</td><td>${gdStr}</td><td class="col-pts">${r.pts}</td></tr>`;
    }).join('');
  }

  /* ---------- Matches tab ---------- */
  function renderMatches() {
    const el    = document.getElementById('matchdays');
    const group = matches.filter(m => m.match_type === 'group');
    if (!group.length) {
      const hint = isAdmin
        ? '<small>Перейдите в «Управление» и сгенерируйте жеребьёвку</small>'
        : '<small>Расписание скоро появится</small>';
      el.innerHTML = '<div class="no-schedule"><p>Расписание ещё не создано</p>' + hint + '</div>';
      return;
    }
    const rounds = {};
    group.forEach(m => { (rounds[m.round] = rounds[m.round] || []).push(m); });

    el.innerHTML = Object.keys(rounds).sort((a,b) => a - b).map(r => {
      const list   = rounds[r];
      const played = list.filter(m => m.played).length;
      return `<div class="matchday">
        <div class="matchday-header"><span>Тур ${r}</span> — ${played}/${list.length} сыграно</div>
        <div class="match-grid">${list.map(m => matchCardHTML(m)).join('')}</div></div>`;
    }).join('');
  }

  function matchCardHTML(m) {
    const hName = tName(m.home_id), aName = tName(m.away_id);
    const score = m.played ? `${m.home_goals} : ${m.away_goals}` : '— : —';
    const pCls  = m.played ? ' played' : '';
    const hW    = m.played && m.home_goals > m.away_goals ? ' match-winner' : '';
    const aW    = m.played && m.away_goals > m.home_goals ? ' match-winner' : '';
    return `<div class="match-card${pCls}" onclick="NML.open(${m.id})">
      <span class="match-home${hW}">${esc(hName)}</span>
      <span class="match-score">${score}</span>
      <span class="match-away${aW}">${esc(aName)}</span></div>`;
  }

  /* ---------- Playoff tab ---------- */
  function groupDone() {
    const g = matches.filter(m => m.match_type === 'group');
    return g.length > 0 && g.every(m => m.played);
  }

  function slotMatch(slot) { return matches.find(m => m.slot === slot) || null; }

  function winner(m) {
    if (!m || !m.played) return null;
    if (m.home_goals > m.away_goals) return m.home_id;
    if (m.away_goals > m.home_goals) return m.away_id;
    return null;
  }

  function renderPlayoff() {
    const el    = document.getElementById('playoffContent');
    const group = matches.filter(m => m.match_type === 'group');

    if (!group.length) {
      el.innerHTML = '<div class="playoff-locked"><div class="lock-icon">🔒</div><p>Плей-офф откроется после группового этапа</p></div>';
      return;
    }

    const played = group.filter(m => m.played).length;
    const total  = group.length;

    if (!groupDone()) {
      const pct = total ? Math.round(played / total * 100) : 0;
      el.innerHTML = `<div class="playoff-locked">
        <div class="lock-icon">⚽</div>
        <p>Групповой этап: ${played} / ${total} матчей</p>
        <div class="playoff-progress"><div class="playoff-progress-bar" style="width:${pct}%"></div></div>
        </div>`;
      return;
    }

    const st = getStandings();

    // Qualification
    const q1 = slotMatch('q1'), q2 = slotMatch('q2');
    let html = `<div class="playoff-section"><h2>Стыковые матчи (7-10 места)</h2><div class="qual-matches">`;
    html += bracketHTML(q1, st[6], st[9], 'q1');
    html += bracketHTML(q2, st[7], st[8], 'q2');
    html += `</div></div>`;

    // If qual not created yet — show button (admin only)
    if (!q1 && !q2 && isAdmin) {
      html += `<div style="text-align:center;margin-bottom:24px">
        <button class="btn-accent" onclick="NML.createQual()">Сформировать стыковые матчи</button></div>`;
    }

    // Playoff bracket
    const q1w = winner(q1), q2w = winner(q2);
    const qualDone = q1 && q2 && q1.played && q2.played;

    const qf1 = slotMatch('qf1'), qf2 = slotMatch('qf2'), qf3 = slotMatch('qf3'), qf4 = slotMatch('qf4');
    const sf1 = slotMatch('sf1'), sf2 = slotMatch('sf2');
    const fin = slotMatch('final');

    html += `<div class="playoff-section"><h2>Плей-офф (Сингл элиминейшн)</h2>`;

    if (qualDone && !qf1 && isAdmin) {
      html += `<div style="text-align:center;margin-bottom:16px">
        <button class="btn-accent" onclick="NML.createQF()">Сформировать четвертьфиналы</button></div>`;
    }

    const qfDone = qf1?.played && qf2?.played && qf3?.played && qf4?.played;
    if (qfDone && !sf1 && isAdmin) {
      html += `<div style="text-align:center;margin-bottom:16px">
        <button class="btn-accent" onclick="NML.createSF()">Сформировать полуфиналы</button></div>`;
    }

    const sfDone = sf1?.played && sf2?.played;
    if (sfDone && !fin && isAdmin) {
      html += `<div style="text-align:center;margin-bottom:16px">
        <button class="btn-accent" onclick="NML.createFinal()">Сформировать финал</button></div>`;
    }

    html += `<div class="bracket">`;

    // QF column
    html += `<div class="bracket-round"><div class="bracket-round-title">Четвертьфинал</div>`;
    html += bracketHTML(qf1, st[0], q2w !== null ? { id: q2w, name: tName(q2w) } : null, 'qf1');
    html += bracketHTML(qf2, st[3], st[4], 'qf2');
    html += bracketHTML(qf3, st[1], q1w !== null ? { id: q1w, name: tName(q1w) } : null, 'qf3');
    html += bracketHTML(qf4, st[2], st[5], 'qf4');
    html += `</div>`;

    // SF column
    html += `<div class="bracket-round"><div class="bracket-round-title">Полуфинал</div>`;
    html += bracketHTML(sf1, winObj(qf1), winObj(qf2), 'sf1');
    html += bracketHTML(sf2, winObj(qf3), winObj(qf4), 'sf2');
    html += `</div>`;

    // Final column
    html += `<div class="bracket-round"><div class="bracket-round-title">Финал</div>`;
    html += bracketHTML(fin, winObj(sf1), winObj(sf2), 'final');
    html += `</div>`;

    // Champion column
    html += `<div class="bracket-round"><div class="bracket-round-title">Чемпион</div>`;
    const champ = winner(fin);
    if (champ !== null) {
      html += `<div class="champion-card"><div class="trophy">🏆</div>
        <div class="champion-name">${esc(tName(champ))}</div>
        <div class="champion-label">Чемпион NML</div></div>`;
    } else {
      html += `<div class="bracket-match no-click"><div class="bracket-team tbd"><span class="team-name">TBD</span><span class="team-score"></span></div></div>`;
    }
    html += `</div></div></div>`;

    el.innerHTML = html;
  }

  function winObj(m) {
    const w = winner(m);
    return w !== null ? { id: w, name: tName(w) } : null;
  }

  function bracketHTML(m, homeObj, awayObj, slot) {
    // m = existing match row (or null)
    // homeObj/awayObj = {id, name} or null
    const homeName = homeObj ? homeObj.name : 'TBD';
    const awayName = awayObj ? awayObj.name : 'TBD';

    if (m && m.played) {
      const w = winner(m);
      const hCls = w === m.home_id ? ' winner' : '';
      const aCls = w === m.away_id ? ' winner' : '';
      return `<div class="bracket-match played" onclick="NML.open(${m.id})">
        <div class="bracket-team${hCls}"><span class="team-name">${esc(tName(m.home_id))}</span><span class="team-score">${m.home_goals}</span></div>
        <div class="bracket-team${aCls}"><span class="team-name">${esc(tName(m.away_id))}</span><span class="team-score">${m.away_goals}</span></div></div>`;
    }

    if (m) {
      // Match exists but not played
      return `<div class="bracket-match" onclick="NML.open(${m.id})">
        <div class="bracket-team"><span class="team-name">${esc(tName(m.home_id))}</span><span class="team-score"></span></div>
        <div class="bracket-team"><span class="team-name">${esc(tName(m.away_id))}</span><span class="team-score"></span></div></div>`;
    }

    // No match yet — placeholder
    const hTbd = homeObj ? '' : ' tbd';
    const aTbd = awayObj ? '' : ' tbd';
    return `<div class="bracket-match no-click">
      <div class="bracket-team${hTbd}"><span class="team-name">${esc(homeName)}</span><span class="team-score"></span></div>
      <div class="bracket-team${aTbd}"><span class="team-name">${esc(awayName)}</span><span class="team-score"></span></div></div>`;
  }

  /* ---------- Admin ---------- */
  function renderAdmin() {
    const list = document.getElementById('teamList');
    list.innerHTML = teams.map(t =>
      `<div class="team-item">
        <span class="team-num">${t.sort_order}.</span>
        <input value="${esc(t.name)}" data-id="${t.id}"
          onchange="NML.rename(${t.id},this.value)"
          onkeydown="if(event.key==='Enter')this.blur()">
      </div>`
    ).join('');

    if (settings.seed) document.getElementById('seedInput').value = settings.seed;

    // Show/hide custom table badge
    const badge = document.getElementById('customTableBadge');
    if (badge) badge.hidden = !customTable;
    fillTeamSelects();
  }

  function fillTeamSelects() {
  const h = document.getElementById('manualHome');
  const a = document.getElementById('manualAway');
  if (!h || !a) return;

  h.innerHTML = a.innerHTML = '';
  teams.forEach(t => {
    h.innerHTML += `<option value="${t.id}">${esc(t.name)}</option>`;
    a.innerHTML += `<option value="${t.id}">${esc(t.name)}</option>`;
  });
}

  /* =========================================================
     ACTIONS — Supabase writes
     ========================================================= */

  /* --- Rename team --- */
  async function renameTeam(id, name) {
    const clean = name.trim() || 'Команда';
    const { error } = await db.from('teams').update({ name: clean }).eq('id', id);
    if (error) { toast('Ошибка сохранения'); console.error(error); return; }
    await loadAll();
  }
  async function addManualMatch() {
  const home_id = +document.getElementById('manualHome').value;
  const away_id = +document.getElementById('manualAway').value;
  const hg = parseInt(document.getElementById('manualHomeGoals').value);
  const ag = parseInt(document.getElementById('manualAwayGoals').value);

  if (home_id === away_id) {
    toast('Команды должны быть разными');
    return;
  }

  const played = Number.isInteger(hg) && Number.isInteger(ag);

  const { error } = await db.from('matches').insert([{
    match_type: 'group',
    slot: null,
    round: null,
    home_id,
    away_id,
    home_goals: played ? hg : null,
    away_goals: played ? ag : null,
    played
  }]);

  if (error) {
    toast('Ошибка добавления матча');
    console.error(error);
    return;
  }

  await loadAll();
  toast('Матч добавлен');
}


  /* --- Generate schedule --- */
  function seededRng(seed) {
    let s = seed | 0;
    return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  }

  function computeSchedule(seed) {
    const rand = seededRng(seed);
    const ids  = teams.map(t => t.id);
    const n    = ids.length;
    if (n < 2) return [];

    const fixed = ids[0];
    const rot   = ids.slice(1);
    const allRounds = [];

    for (let r = 0; r < n - 1; r++) {
      const pairs = [];
      pairs.push([fixed, rot[0]]);
      for (let i = 1; i < n / 2; i++) pairs.push([rot[i], rot[n - 2 - i]]);
      allRounds.push(pairs);
      rot.push(rot.shift());
    }

    // Shuffle indices, pick first MATCHES_PER_TEAM rounds
    const idx = Array.from({ length: n - 1 }, (_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const chosen = idx.slice(0, MATCHES_PER_TEAM);

    const rows = [];
    chosen.forEach((ri, tour) => {
      allRounds[ri].forEach(([a, b]) => {
        const swap = rand() > 0.5;
        rows.push({
          match_type: 'group',
          slot: null,
          round: tour + 1,
          home_id: swap ? b : a,
          away_id: swap ? a : b,
          home_goals: null,
          away_goals: null,
          played: false,
        });
      });
    });
    return rows;
  }

  async function generateSchedule() {
    const seedVal = parseInt(document.getElementById('seedInput').value);
    if (isNaN(seedVal)) { toast('Введите число для жеребьёвки'); return; }

    const hasPlayed = matches.some(m => m.played);
    if (hasPlayed && !confirm('Все результаты будут сброшены. Продолжить?')) return;

    document.getElementById('generateBtn').disabled = true;

    // Delete all matches
    await db.from('matches').delete().gt('id', 0);

    // Insert new schedule
    const rows = computeSchedule(seedVal);
    if (rows.length) {
      const { error } = await db.from('matches').insert(rows);
      if (error) { toast('Ошибка создания расписания'); console.error(error); document.getElementById('generateBtn').disabled = false; return; }
    }

    // Save seed
    await db.from('settings').upsert({ key: 'seed', value: String(seedVal) });

    await loadAll();
    document.getElementById('generateBtn').disabled = false;
    toast('Расписание создано — ' + rows.length + ' матчей');
    document.querySelector('.nav-btn[data-tab="matches"]').click();
  }

  /* --- Reset data --- */
  async function resetData() {
    if (!confirm('Все матчи будут удалены. Команды останутся. Продолжить?')) return;
    await db.from('matches').delete().gt('id', 0);
    await db.from('settings').delete().gt('key', '');
    await loadAll();
    toast('Данные сброшены');
  }

  /* --- Create knockout stages --- */
  async function createQual() {
    const st = getStandings();
    if (st.length < 10) return;
    const rows = [
      { match_type: 'qual', slot: 'q1', round: null, home_id: st[6].id, away_id: st[9].id, played: false },
      { match_type: 'qual', slot: 'q2', round: null, home_id: st[7].id, away_id: st[8].id, played: false },
    ];
    const { error } = await db.from('matches').insert(rows);
    if (error) { toast('Ошибка создания стыковых'); console.error(error); return; }
    await loadAll();
    toast('Стыковые матчи созданы');
  }

  async function createQF() {
    const st  = getStandings();
    const q1w = winner(slotMatch('q1'));
    const q2w = winner(slotMatch('q2'));
    if (!q1w || !q2w) { toast('Сначала завершите стыковые матчи'); return; }
    const rows = [
      { match_type: 'qf', slot: 'qf1', round: null, home_id: st[0].id, away_id: q2w,      played: false },
      { match_type: 'qf', slot: 'qf2', round: null, home_id: st[3].id, away_id: st[4].id,  played: false },
      { match_type: 'qf', slot: 'qf3', round: null, home_id: st[1].id, away_id: q1w,       played: false },
      { match_type: 'qf', slot: 'qf4', round: null, home_id: st[2].id, away_id: st[5].id,  played: false },
    ];
    const { error } = await db.from('matches').insert(rows);
    if (error) { toast('Ошибка создания ЧФ'); console.error(error); return; }
    await loadAll();
    toast('Четвертьфиналы созданы');
  }

  async function createSF() {
    const qf1w = winner(slotMatch('qf1')), qf2w = winner(slotMatch('qf2'));
    const qf3w = winner(slotMatch('qf3')), qf4w = winner(slotMatch('qf4'));
    if (!qf1w || !qf2w || !qf3w || !qf4w) { toast('Сначала завершите все ЧФ'); return; }
    const rows = [
      { match_type: 'sf', slot: 'sf1', round: null, home_id: qf1w, away_id: qf2w, played: false },
      { match_type: 'sf', slot: 'sf2', round: null, home_id: qf3w, away_id: qf4w, played: false },
    ];
    const { error } = await db.from('matches').insert(rows);
    if (error) { toast('Ошибка создания ПФ'); console.error(error); return; }
    await loadAll();
    toast('Полуфиналы созданы');
  }

  async function createFinal() {
    const sf1w = winner(slotMatch('sf1')), sf2w = winner(slotMatch('sf2'));
    if (!sf1w || !sf2w) { toast('Сначала завершите полуфиналы'); return; }
    const row = { match_type: 'final', slot: 'final', round: null, home_id: sf1w, away_id: sf2w, played: false };
    const { error } = await db.from('matches').insert([row]);
    if (error) { toast('Ошибка создания финала'); console.error(error); return; }
    await loadAll();
    toast('Финал создан!');
  }

  /* =========================================================
     IMPORT / EXPORT
     ========================================================= */

  /* --- Export matches as JSON --- */
  function exportMatches() {
    const data = matches.map(m => ({
      match_type: m.match_type,
      slot:       m.slot,
      round:      m.round,
      home:       tName(m.home_id),
      away:       tName(m.away_id),
      home_goals: m.home_goals,
      away_goals: m.away_goals,
      played:     m.played,
    }));
    downloadJSON(data, 'nml-matches.json');
    toast('Матчи скачаны');
  }

  /* --- Import matches from JSON --- */
  async function importMatches(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch { toast('Ошибка чтения JSON'); return; }

    if (!Array.isArray(data) || !data.length) { toast('Файл пуст или неверный формат'); return; }

    // Build name → id map
    const nameMap = {};
    teams.forEach(t => { nameMap[t.name.toLowerCase()] = t.id; });

    // Validate all team names exist
    const missing = new Set();
    data.forEach(m => {
      if (!nameMap[(m.home || '').toLowerCase()]) missing.add(m.home);
      if (!nameMap[(m.away || '').toLowerCase()]) missing.add(m.away);
    });
    if (missing.size) {
      toast('Не найдены команды: ' + [...missing].join(', '));
      return;
    }

    if (!confirm(`Импорт ${data.length} матчей. Все текущие матчи будут заменены. Продолжить?`)) return;

    // Delete old matches
    await db.from('matches').delete().gt('id', 0);

    // Build rows
    const rows = data.map(m => ({
      match_type: m.match_type || 'group',
      slot:       m.slot || null,
      round:      m.round || null,
      home_id:    nameMap[m.home.toLowerCase()],
      away_id:    nameMap[m.away.toLowerCase()],
      home_goals: m.played !== false && m.home_goals != null ? m.home_goals : null,
      away_goals: m.played !== false && m.away_goals != null ? m.away_goals : null,
      played:     m.played !== false && m.home_goals != null && m.away_goals != null,
    }));

    const { error } = await db.from('matches').insert(rows);
    if (error) { toast('Ошибка импорта матчей'); console.error(error); return; }

    await loadAll();
    toast('Импортировано ' + rows.length + ' матчей');
  }

  /* --- Export standings table as JSON --- */
  function exportTable() {
    const st = customTable || getStandings();
    const data = st.map((r, i) => ({
      pos:  i + 1,
      name: r.name,
      p: r.p, w: r.w, d: r.d, l: r.l,
      gs: r.gs, gc: r.gc,
      gd: r.gd != null ? r.gd : r.gs - r.gc,
      pts: r.pts,
    }));
    downloadJSON(data, 'nml-table.json');
    toast('Таблица скачана');
  }

  /* --- Import standings table from JSON --- */
async function importTable(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('Ошибка чтения JSON');
    return;
  }

  if (!Array.isArray(data) || !data.length) {
    toast('Файл пуст или неверный формат');
    return;
  }

  // name → team
  const teamMap = {};
  teams.forEach(t => {
    teamMap[t.name.toLowerCase()] = t.name;
  });

  const missing = [];
  customTable = data.map(r => {
    const realName = teamMap[r.name.toLowerCase()];
    if (!realName) missing.push(r.name);

    return {
      name: realName || r.name,
      p: r.p, w: r.w, d: r.d, l: r.l,
      gs: r.gs, gc: r.gc,
      gd: r.gd != null ? r.gd : r.gs - r.gc,
      pts: r.pts,
    };
  });

  if (missing.length) {
    toast('Не найдены команды: ' + missing.join(', '));
    customTable = null;
    return;
  }

  customTable.sort(
    (a, b) => b.pts - a.pts || b.gd - a.gd || b.gs - a.gs || a.name.localeCompare(b.name)
  );

  await db.from('settings').upsert({
    key: 'custom_table',
    value: JSON.stringify(customTable),
  });

  render();
  toast('Таблица загружена с реальными названиями');
}


  /* --- Clear custom table --- */
  async function clearCustomTable() {
    customTable = null;
    await db.from('settings').delete().eq('key', 'custom_table');
    render();
    toast('Загруженная таблица сброшена');
  }

  /* --- Helper: download JSON --- */
  function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* =========================================================
     MODAL — enter / edit / clear match result
     ========================================================= */
  let modalMatchId = null;

  function openModal(matchId) {
    if (!isAdmin) return;
    const m = matches.find(x => x.id === matchId);
    if (!m) return;

    modalMatchId = matchId;
    document.getElementById('modalHomeName').textContent  = tName(m.home_id);
    document.getElementById('modalAwayName').textContent  = tName(m.away_id);
    document.getElementById('modalHomeGoals').value = m.played ? m.home_goals : 0;
    document.getElementById('modalAwayGoals').value = m.played ? m.away_goals : 0;
    document.getElementById('modalClear').style.display = m.played ? '' : 'none';

    const isKnockout = m.match_type !== 'group';
    document.getElementById('modalTitle').textContent =
      isKnockout ? 'Результат (плей-офф — ничья невозможна)' : 'Результат матча';

    document.getElementById('modal').hidden = false;
    const inp = document.getElementById('modalHomeGoals');
    inp.focus(); inp.select();
  }

  function closeModal() {
    document.getElementById('modal').hidden = true;
    modalMatchId = null;
  }

  async function saveModal() {
    if (modalMatchId === null) return;
    const hg = Math.max(0, parseInt(document.getElementById('modalHomeGoals').value) || 0);
    const ag = Math.max(0, parseInt(document.getElementById('modalAwayGoals').value) || 0);

    const m = matches.find(x => x.id === modalMatchId);
    if (!m) return;

    // Knockout: no draws
    if (m.match_type !== 'group' && hg === ag) {
      toast('В плей-офф ничья невозможна!');
      return;
    }

    const { error } = await db.from('matches')
      .update({ home_goals: hg, away_goals: ag, played: true })
      .eq('id', modalMatchId);

    if (error) { toast('Ошибка сохранения'); console.error(error); return; }

    closeModal();
    await loadAll();
    toast('Результат сохранён');
    syncToSheets();
  }

  async function clearModal() {
    if (modalMatchId === null) return;
    const m = matches.find(x => x.id === modalMatchId);
    if (!m) return;

    // Clear this match
    await db.from('matches')
      .update({ home_goals: null, away_goals: null, played: false })
      .eq('id', modalMatchId);

    // Clear downstream knockout matches
    const downstream = {
      'qual':  ['qf', 'sf', 'final'],
      'qf':    ['sf', 'final'],
      'sf':    ['final'],
    };
    const stages = downstream[m.match_type];
    if (stages && stages.length) {
      await db.from('matches').delete().in('match_type', stages);
    }

    closeModal();
    await loadAll();
    toast('Результат очищен');
    syncToSheets();
  }

  /* =========================================================
     AUTH — admin access by secret code
     ========================================================= */
  function initAuth() {
    const lockBtn  = document.getElementById('lockBtn');
    const codeBox  = document.getElementById('codeBox');
    const codeInp  = document.getElementById('adminCode');

    lockBtn.addEventListener('click', () => {
      if (isAdmin) { logout(); return; }
      // Toggle code input
      const show = codeBox.hidden;
      codeBox.hidden = !show;
      if (show) { codeInp.value = ''; codeInp.focus(); }
    });

    codeInp.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        if (codeInp.value === ADMIN_CODE) {
          login();
        } else {
          toast('Неверный код');
          codeInp.value = '';
        }
      }
      if (e.key === 'Escape') { codeBox.hidden = true; }
    });
  }

  function login() {
    isAdmin = true;
    sessionStorage.setItem('nml_admin', '1');
    document.getElementById('codeBox').hidden = true;
    document.getElementById('adminCode').value = '';
    applyAdminMode();
    toast('Админ-режим активирован');
    // Switch to admin tab
    document.querySelector('.nav-btn[data-tab="admin"]').click();
  }

  function logout() {
    isAdmin = false;
    sessionStorage.removeItem('nml_admin');
    applyAdminMode();
    // Switch away from admin tab if on it
    document.querySelector('.nav-btn[data-tab="table"]').click();
    toast('Вы вышли из админ-режима');
  }

  function applyAdminMode() {
    document.body.classList.toggle('admin-mode', isAdmin);

    // Show/hide admin tab button
    const adminTabBtn = document.querySelector('.nav-btn[data-tab="admin"]');
    adminTabBtn.style.display = isAdmin ? '' : 'none';

    // Lock icon
    document.getElementById('lockBtn').textContent = isAdmin ? '🔓' : '🔒';
    document.getElementById('lockBtn').title = isAdmin ? 'Выйти из админ-режима' : 'Вход для администратора';

    // Admin badge
    document.getElementById('adminBadge').hidden = !isAdmin;
  }

  /* =========================================================
     TABS
     ========================================================= */
  function initTabs() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      });
    });
  }

  /* =========================================================
     ADMIN LISTENERS
     ========================================================= */
  function initAdmin() {
    document.getElementById('generateBtn').addEventListener('click', generateSchedule);
    document.getElementById('resetBtn').addEventListener('click', resetData);
    document.getElementById('addMatchBtn') ?.addEventListener('click', addManualMatch);


    // Import / Export
    document.getElementById('exportMatchesBtn').addEventListener('click', exportMatches);
    document.getElementById('importMatchesFile').addEventListener('change', e => {
      if (e.target.files[0]) { importMatches(e.target.files[0]); e.target.value = ''; }
    });
    document.getElementById('exportTableBtn').addEventListener('click', exportTable);
    document.getElementById('importTableFile').addEventListener('change', e => {
      if (e.target.files[0]) { importTable(e.target.files[0]); e.target.value = ''; }
    });
    document.getElementById('clearCustomTable').addEventListener('click', clearCustomTable);
  }

  /* =========================================================
     MODAL LISTENERS
     ========================================================= */
  function initModal() {
    document.getElementById('modalSave').addEventListener('click', saveModal);
    document.getElementById('modalClear').addEventListener('click', clearModal);
    document.getElementById('modalCancel').addEventListener('click', closeModal);
    document.getElementById('modal').addEventListener('click', e => {
      if (e.target.id === 'modal') closeModal();
    });
    document.getElementById('modalHomeGoals').addEventListener('keydown', e => { if (e.key === 'Enter') saveModal(); });
    document.getElementById('modalAwayGoals').addEventListener('keydown', e => { if (e.key === 'Enter') saveModal(); });
  }

  /* =========================================================
     GOOGLE SHEETS SYNC — fire-and-forget after each result
     ========================================================= */
  async function syncToSheets() {
    try {
      const standings = getStandings();
      const played = matches.filter(m => m.played).map(m => ({
        type:      m.match_type,
        round:     m.round,
        home:      tName(m.home_id),
        homeGoals: m.home_goals,
        awayGoals: m.away_goals,
        away:      tName(m.away_id),
      }));
      // Sort: group first (by round), then knockout stages
      const order = { group: 0, qual: 1, qf: 2, sf: 3, final: 4 };
      played.sort((a, b) => (order[a.type] || 0) - (order[b.type] || 0) || (a.round || 0) - (b.round || 0));

      const res = await fetch('/api/sheets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ standings, matches: played }),
      });
      if (!res.ok) console.warn('Sheets sync failed:', await res.text());
    } catch (e) {
      console.warn('Sheets sync error:', e);
    }
  }

  /* =========================================================
     HELPERS
     ========================================================= */
  function tName(id) {
    if (id === null || id === undefined) return 'TBD';
    const t = teams.find(t => t.id === id);
    return t ? t.name : '???';
  }

  function esc(s) {
    if (!s) return '';
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  let toastTimer;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
  }

  /* =========================================================
     PUBLIC API (for inline onclick handlers)
     ========================================================= */
  window.NML = {
    open:             openModal,
    rename:           renameTeam,
    createQual:       createQual,
    createQF:         createQF,
    createSF:         createSF,
    createFinal:      createFinal,
    logout:           logout,
    exportMatches:    exportMatches,
    exportTable:      exportTable,
    clearCustomTable: clearCustomTable,
  };

})();
