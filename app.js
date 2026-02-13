(function () {
  'use strict';

  /* =========================================================
     CONFIG
     ========================================================= */
  const SUPABASE_URL     = 'https://dvctnhmerpuuzxmawxwz.supabase.co';
  const SUPABASE_KEY     = 'sb_publishable_OjUhXapGim0eeHOomfcbpw_ObN0jpsl';
  const TEAMS_COUNT      = 16;
  const MATCHES_PER_TEAM = 8;
  const ADMIN_CODE       = 'altasigmaemirloh';

  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  /* =========================================================
     IN-MEMORY STATE
     ========================================================= */
  let teams       = [];   // [{id, name, sort_order, logo}]
  let matches     = [];   // [{id, match_type, slot, round, home_id, away_id, home_goals, away_goals, played}]
  let settings    = {};   // {seed: '...'}
  let players     = [];   // [{id, team_id, name, number, rating, sort_order}]
  let goals       = [];   // [{id, match_id, player_id, team_id, is_own_goal}]
  let isAdmin     = sessionStorage.getItem('nml_admin') === '1';
  let customTable = null;

  // Team modal state
  let currentTeamId  = null;

  // Match modal state
  let modalMatchId = null;
  let modalGoals   = []; // [{player_id, team_id, player_name}] – working copy

  // Players tab filter
  let playerFilter = '';

  /* =========================================================
     BOOTSTRAP
     ========================================================= */
  document.addEventListener('DOMContentLoaded', async () => {
    initTabs();
    initAdmin();
    initModal();
    initAuth();
    initTeamModal();
    applyAdminMode();
    try {
      await loadAll();
      subscribeRealtime();
    } catch (e) {
      console.error('Bootstrap error', e);
      toast('Ошибка загрузки — проверьте консоль');
    } finally {
      // Всегда показываем приложение, даже если что-то упало
      document.getElementById('loading').style.display = 'none';
      document.getElementById('app').style.display = '';
    }
  });

  /* =========================================================
     DATA — load everything from Supabase
     ========================================================= */
  async function loadAll() {
    // 1. Обязательные таблицы — без них смысла нет
    const [tRes, mRes, sRes] = await Promise.all([
      db.from('teams').select('*').order('sort_order'),
      db.from('matches').select('*').order('id'),
      db.from('settings').select('*'),
    ]);

    if (tRes.error || mRes.error || sRes.error) {
      console.error('Load error', tRes.error, mRes.error, sRes.error);
      toast('Ошибка загрузки данных');
      return;
    }

    teams   = tRes.data || [];
    matches = mRes.data || [];
    settings = {};
    (sRes.data || []).forEach(r => { settings[r.key] = r.value; });

    // 2. Необязательные таблицы — падение не ломает сайт.
    //    Если migration.sql ещё не запускали — просто пустые массивы.
    players = await db.from('players').select('*').order('sort_order').order('id')
      .then(r => r.error ? [] : (r.data || []))
      .catch(() => []);

    goals = await db.from('goals').select('*').order('id')
      .then(r => r.error ? [] : (r.data || []))
      .catch(() => []);

    // Restore custom table from settings
    if (settings.custom_table) {
      try { customTable = JSON.parse(settings.custom_table); } catch { customTable = null; }
    } else {
      customTable = null;
    }

    render();
  }

  /* =========================================================
     REALTIME
     ========================================================= */
  let reloadTimer;
  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(loadAll, 600);
  }

  function subscribeRealtime() {
    try {
      db.channel('nml-live')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, scheduleReload)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'teams' },   scheduleReload)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, scheduleReload)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'goals' },   scheduleReload)
        .subscribe(status => {
          if (status === 'CHANNEL_ERROR') console.warn('Realtime error (non-fatal)');
        });
    } catch (e) {
      console.warn('Realtime init failed (non-fatal):', e);
    }
  }

  /* =========================================================
     RENDER
     ========================================================= */
  function render() {
    renderStats();
    renderTable();
    renderMatches();
    renderPlayoff();
    renderAdmin();
    renderPlayersTab();
    fillTeamFilter();
  }

  /* ---------- Stats bar ---------- */
  function renderStats() {
    const group  = matches.filter(m => m.match_type === 'group');
    const played = group.filter(m => m.played).length;
    const total  = group.length;
    const gcount = group.filter(m => m.played).reduce((s,m) => s + (m.home_goals||0) + (m.away_goals||0), 0);
    document.getElementById('statTeams').textContent     = teams.length;
    document.getElementById('statPlayed').textContent    = played;
    document.getElementById('statGoals').textContent     = gcount;
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

  function teamLogoHTML(teamId, cls = 'team-logo-sm', phCls = 'team-logo-placeholder-sm') {
    const t = teams.find(x => x.id === teamId);
    if (t && t.logo) {
      return `<img src="${esc(t.logo)}" class="${cls}" alt="">`;
    }
    return `<span class="${phCls}">⚽</span>`;
  }

  function renderTable() {
    const st = customTable || getStandings();
    document.getElementById('tableBody').innerHTML = st.map((r, i) => {
      const pos   = i + 1;
      const cls   = pos <= 6 ? 'zone-playoff-row' : pos <= 10 ? 'zone-qual-row' : 'zone-out-row';
      const gd    = (r.gd != null ? r.gd : r.gs - r.gc);
      const gdStr = gd > 0 ? '+' + gd : gd;
      const tid   = r.id || (teams.find(t => t.name === r.name) || {}).id;
      const logo  = teamLogoHTML(tid);
      const click = tid ? `onclick="NML.openTeam(${tid})"` : '';
      return `<tr class="${cls}">
        <td class="col-pos">${pos}</td>
        <td class="col-team" ${click}>
          <div class="team-cell">${logo}<span class="team-cell-name">${esc(r.name)}</span></div>
        </td>
        <td>${r.p}</td><td>${r.w}</td><td>${r.d}</td><td>${r.l}</td>
        <td>${r.gs}</td><td>${r.gc}</td><td>${gdStr}</td>
        <td class="col-pts">${r.pts}</td></tr>`;
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
    const hName  = tName(m.home_id), aName = tName(m.away_id);
    const score  = m.played ? `${m.home_goals} : ${m.away_goals}` : '— : —';
    const pCls   = m.played ? ' played' : '';
    const hW     = m.played && m.home_goals > m.away_goals ? ' match-winner' : '';
    const aW     = m.played && m.away_goals > m.home_goals ? ' match-winner' : '';
    const hLogo  = teamLogoHTML(m.home_id);
    const aLogo  = teamLogoHTML(m.away_id);
    const gCount = goals.filter(g => g.match_id === m.id).length;
    const gTag   = (m.played && gCount > 0) ? `<span class="match-goal-count">⚽ ${gCount}</span>` : '';
    return `<div class="match-card${pCls}" onclick="NML.open(${m.id})">
      <span class="match-home${hW}">${hLogo}${esc(hName)}</span>
      <span class="match-score">${score}${gTag}</span>
      <span class="match-away${aW}">${esc(aName)}${aLogo}</span></div>`;
  }

  /* ---------- Players Tab ---------- */
  function fillTeamFilter() {
    const sel = document.getElementById('playerTeamFilter');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">Все команды</option>' +
      teams.map(t => `<option value="${t.id}" ${String(t.id) === current ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  }

  function renderPlayersTab() {
    const el = document.getElementById('playersContent');
    if (!el) return;

    // Build goal counts per player
    const goalMap = {};
    goals.forEach(g => {
      if (g.player_id) goalMap[g.player_id] = (goalMap[g.player_id] || 0) + 1;
    });

    // Filter
    const filteredTeams = playerFilter
      ? teams.filter(t => String(t.id) === String(playerFilter))
      : teams;

    let allPlayers = players.filter(p =>
      !playerFilter || String(p.team_id) === String(playerFilter)
    );

    if (!allPlayers.length) {
      el.innerHTML = `<div class="players-empty">
        <div class="empty-icon">👥</div>
        <p>${playerFilter ? 'В этой команде пока нет игроков' : 'Игроки ещё не добавлены'}</p>
        ${isAdmin ? '<p style="margin-top:8px;font-size:.8rem;opacity:.5">Откройте команду из таблицы и добавьте состав</p>' : ''}
      </div>`;
      return;
    }

    // Sort by goals desc, then rating desc, then name
    const sorted = [...allPlayers].sort((a, b) => {
      const ga = goalMap[a.id] || 0, gb = goalMap[b.id] || 0;
      if (gb !== ga) return gb - ga;
      const ra = a.rating || 0, rb = b.rating || 0;
      if (rb !== ra) return rb - ra;
      return (a.name || '').localeCompare(b.name || '');
    });

    const rows = sorted.map((p, i) => {
      const team   = teams.find(t => t.id === p.team_id) || {};
      const g      = goalMap[p.id] || 0;
      const logo   = team.logo
        ? `<img src="${esc(team.logo)}" class="scorer-logo-sm" alt="">`
        : `<div class="scorer-logo-placeholder">⚽</div>`;
      const rank   = i + 1;
      const rankCls = rank <= 3 ? ' top' : '';
      const rating = p.rating != null
        ? `<div class="scorer-rating-col"><span class="scorer-rating-val">${p.rating}</span></div>` : '';
      return `<div class="scorer-row">
        <div class="scorer-rank${rankCls}">${rank}</div>
        ${logo}
        <div class="scorer-info">
          <div class="scorer-name">${esc(p.name)}${p.number ? ` <span style="opacity:.4;font-weight:400">#${p.number}</span>` : ''}</div>
          <div class="scorer-team-name">${esc(team.name || '')}</div>
        </div>
        <div class="scorer-goals-col">
          <span class="scorer-goals-num">${g}</span>
          <span class="scorer-goals-label">гол${g === 1 ? '' : g < 5 && g > 1 ? 'а' : 'ов'}</span>
        </div>
        ${rating}
      </div>`;
    }).join('');

    el.innerHTML = `<div class="scorers-list">${rows}</div>`;
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

    const q1 = slotMatch('q1'), q2 = slotMatch('q2');
    let html = `<div class="playoff-section"><h2>Стыковые матчи (7-10 места)</h2><div class="qual-matches">`;
    html += bracketHTML(q1, st[6], st[9], 'q1');
    html += bracketHTML(q2, st[7], st[8], 'q2');
    html += `</div></div>`;

    if (!q1 && !q2 && isAdmin) {
      html += `<div style="text-align:center;margin-bottom:24px">
        <button class="btn-accent" onclick="NML.createQual()">Сформировать стыковые матчи</button></div>`;
    }

    const q1w = winner(q1), q2w = winner(q2);
    const qualDone = q1 && q2 && q1.played && q2.played;

    const qf1 = slotMatch('qf1'), qf2 = slotMatch('qf2'),
          qf3 = slotMatch('qf3'), qf4 = slotMatch('qf4');
    const sf1 = slotMatch('sf1'), sf2 = slotMatch('sf2');
    const fin = slotMatch('final');

    html += `<div class="playoff-section"><h2>Плей-офф (Сингл элиминейшн)</h2>`;

    if (qualDone && !qf1 && isAdmin)
      html += `<div style="text-align:center;margin-bottom:16px">
        <button class="btn-accent" onclick="NML.createQF()">Сформировать четвертьфиналы</button></div>`;

    const qfDone = qf1?.played && qf2?.played && qf3?.played && qf4?.played;
    if (qfDone && !sf1 && isAdmin)
      html += `<div style="text-align:center;margin-bottom:16px">
        <button class="btn-accent" onclick="NML.createSF()">Сформировать полуфиналы</button></div>`;

    const sfDone = sf1?.played && sf2?.played;
    if (sfDone && !fin && isAdmin)
      html += `<div style="text-align:center;margin-bottom:16px">
        <button class="btn-accent" onclick="NML.createFinal()">Сформировать финал</button></div>`;

    html += `<div class="bracket">`;

    html += `<div class="bracket-round"><div class="bracket-round-title">Четвертьфинал</div>`;
    html += bracketHTML(qf1, st[0], q2w !== null ? { id: q2w, name: tName(q2w) } : null, 'qf1');
    html += bracketHTML(qf2, st[3], st[4], 'qf2');
    html += bracketHTML(qf3, st[1], q1w !== null ? { id: q1w, name: tName(q1w) } : null, 'qf3');
    html += bracketHTML(qf4, st[2], st[5], 'qf4');
    html += `</div>`;

    html += `<div class="bracket-round"><div class="bracket-round-title">Полуфинал</div>`;
    html += bracketHTML(sf1, winObj(qf1), winObj(qf2), 'sf1');
    html += bracketHTML(sf2, winObj(qf3), winObj(qf4), 'sf2');
    html += `</div>`;

    html += `<div class="bracket-round"><div class="bracket-round-title">Финал</div>`;
    html += bracketHTML(fin, winObj(sf1), winObj(sf2), 'final');
    html += `</div>`;

    html += `<div class="bracket-round"><div class="bracket-round-title">Чемпион</div>`;
    const champ = winner(fin);
    if (champ !== null) {
      const champLogo = teamLogoHTML(champ, 'team-logo-lg', 'logo-placeholder-lg');
      html += `<div class="champion-card">${champLogo}<div class="trophy">🏆</div>
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
      return `<div class="bracket-match" onclick="NML.open(${m.id})">
        <div class="bracket-team"><span class="team-name">${esc(tName(m.home_id))}</span><span class="team-score"></span></div>
        <div class="bracket-team"><span class="team-name">${esc(tName(m.away_id))}</span><span class="team-score"></span></div></div>`;
    }
    const hTbd = homeObj ? '' : ' tbd';
    const aTbd = awayObj ? '' : ' tbd';
    return `<div class="bracket-match no-click">
      <div class="bracket-team${hTbd}"><span class="team-name">${esc(homeName)}</span><span class="team-score"></span></div>
      <div class="bracket-team${aTbd}"><span class="team-name">${esc(awayName)}</span><span class="team-score"></span></div></div>`;
  }

  /* ---------- Admin ---------- */
  function renderAdmin() {
    const list = document.getElementById('teamList');
    if (!list) return;
    list.innerHTML = teams.map(t => {
      const logoHTML = t.logo
        ? `<img src="${esc(t.logo)}" class="team-item-logo" title="Кликните, чтобы сменить логотип" onclick="NML.promptLogoUpload(${t.id})">`
        : `<div class="team-item-logo-ph" title="Загрузить логотип" onclick="NML.promptLogoUpload(${t.id})">⚽</div>`;
      return `<div class="team-item">
        <span class="team-num">${t.sort_order}.</span>
        ${logoHTML}
        <input value="${esc(t.name)}" data-id="${t.id}"
          onchange="NML.rename(${t.id},this.value)"
          onkeydown="if(event.key==='Enter')this.blur()">
      </div>`;
    }).join('');

    if (settings.seed) document.getElementById('seedInput').value = settings.seed;

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
     TEAM MODAL
     ========================================================= */
  function openTeamModal(teamId) {
    currentTeamId = teamId;
    renderTeamModal();
    document.getElementById('teamModal').hidden = false;
  }

  function closeTeamModal() {
    document.getElementById('teamModal').hidden = true;
    currentTeamId = null;
  }

  function renderTeamModal() {
    const t = teams.find(x => x.id === currentTeamId);
    if (!t) return;

    // Header
    document.getElementById('tmTitle').textContent = t.name;
    const img = document.getElementById('tmLogoImg');
    const ph  = document.getElementById('tmLogoPlaceholder');
    if (t.logo) {
      img.src    = t.logo;
      img.hidden = false;
      ph.hidden  = true;
    } else {
      img.hidden = true;
      ph.hidden  = false;
    }

    // Stats for this team
    const st = getStandings().find(r => r.id === currentTeamId) || {};
    const teamGoals = goals.filter(g => g.team_id === currentTeamId && !g.is_own_goal).length;
    const pCount    = players.filter(p => p.team_id === currentTeamId).length;
    document.getElementById('tmMeta').innerHTML =
      `<span class="meta-item">📋 ${pCount} игрок${pCount === 1 ? '' : pCount < 5 ? 'а' : 'ов'}</span>` +
      (st.pts != null ? `<span class="meta-item">🏆 ${st.pts} очков</span>` : '') +
      `<span class="meta-item">⚽ ${teamGoals} гол${teamGoals === 1 ? '' : teamGoals < 5 && teamGoals > 1 ? 'а' : 'ов'} забито</span>`;

    // Roster
    renderRoster();
  }

  function renderRoster() {
    const roster = players.filter(p => p.team_id === currentTeamId)
      .sort((a,b) => (a.number||999) - (b.number||999) || (a.name||'').localeCompare(b.name||''));

    const goalMap = {};
    goals.forEach(g => { if (g.player_id) goalMap[g.player_id] = (goalMap[g.player_id] || 0) + 1; });

    const el = document.getElementById('tmRoster');
    if (!roster.length) {
      el.innerHTML = `<div class="no-players-msg">
        👥 Состав пока не добавлен${isAdmin ? '<br><small>Нажмите «+ Игрок», чтобы добавить</small>' : ''}
      </div>`;
      return;
    }

    el.innerHTML = roster.map(p => {
      const g     = goalMap[p.id] || 0;
      const gCls  = g ? '' : ' zero';
      const rBadge = p.rating != null ? `<span class="player-rating">★ ${p.rating}</span>` : '';
      return `<div class="player-item">
        <span class="player-num">${p.number ? '#' + p.number : '—'}</span>
        <span class="player-name">${esc(p.name)}</span>
        ${rBadge}
        <span class="player-goals-badge${gCls}">⚽ ${g}</span>
        <button class="btn-remove-player" onclick="NML.removePlayer(${p.id})" title="Удалить игрока">✕</button>
      </div>`;
    }).join('');
  }

  function initTeamModal() {
    // Close on backdrop click
    document.getElementById('teamModal').addEventListener('click', e => {
      if (e.target.id === 'teamModal') closeTeamModal();
    });
    // Logo file input
    document.getElementById('tmLogoInput').addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      await uploadLogoForTeam(currentTeamId, file);
      e.target.value = '';
    });
  }

  async function addPlayer() {
    const num  = parseInt(document.getElementById('apNum').value) || null;
    const name = document.getElementById('apName').value.trim();
    const rat  = parseFloat(document.getElementById('apRating').value);
    if (!name) { toast('Введите имя игрока'); return; }

    const { error } = await db.from('players').insert([{
      team_id:    currentTeamId,
      name,
      number:     num,
      rating:     isNaN(rat) ? null : rat,
      sort_order: players.filter(p => p.team_id === currentTeamId).length,
    }]);
    if (error) { toast('Ошибка добавления игрока'); console.error(error); return; }
    document.getElementById('apNum').value = '';
    document.getElementById('apName').value = '';
    document.getElementById('apRating').value = '';
    await loadAll();
    renderTeamModal();
    toast('Игрок добавлен');
  }

  async function removePlayer(playerId) {
    if (!confirm('Удалить игрока? Голы также будут удалены.')) return;
    await db.from('goals').delete().eq('player_id', playerId);
    const { error } = await db.from('players').delete().eq('id', playerId);
    if (error) { toast('Ошибка удаления'); console.error(error); return; }
    await loadAll();
    if (currentTeamId) renderTeamModal();
    toast('Игрок удалён');
  }

  function toggleAddPlayerForm() {
    const form = document.getElementById('addPlayerForm');
    form.classList.toggle('visible');
    if (form.classList.contains('visible')) {
      document.getElementById('apName').focus();
    }
  }

  /* =========================================================
     LOGO UPLOAD
     ========================================================= */
  async function uploadLogoForTeam(teamId, file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const dataUrl = e.target.result;
      const { error } = await db.from('teams').update({ logo: dataUrl }).eq('id', teamId);
      if (error) { toast('Ошибка загрузки логотипа'); console.error(error); return; }
      await loadAll();
      if (currentTeamId === teamId) renderTeamModal();
      toast('Логотип сохранён');
    };
    reader.readAsDataURL(file);
  }

  // Admin team list logo upload — create hidden file input, trigger it
  function promptLogoUpload(teamId) {
    if (!isAdmin) return;
    const inp = document.createElement('input');
    inp.type  = 'file';
    inp.accept = 'image/*';
    inp.onchange = async e => {
      if (e.target.files[0]) await uploadLogoForTeam(teamId, e.target.files[0]);
    };
    inp.click();
  }

  /* =========================================================
     MATCH MODAL — with goal scorers
     ========================================================= */
  function openModal(matchId) {
    if (!isAdmin) return;
    const m = matches.find(x => x.id === matchId);
    if (!m) return;

    modalMatchId = matchId;
    document.getElementById('modalHomeName').textContent  = tName(m.home_id);
    document.getElementById('modalAwayName').textContent  = tName(m.away_id);
    document.getElementById('modalHomeGoals').value = m.played ? m.home_goals : 0;
    document.getElementById('modalAwayGoals').value = m.played ? m.away_goals : 0;
    document.getElementById('modalClear').style.display   = m.played ? '' : 'none';

    const isKnockout = m.match_type !== 'group';
    document.getElementById('modalTitle').textContent =
      isKnockout ? 'Результат (плей-офф — ничья невозможна)' : 'Результат матча';

    // Load existing goals for this match into modalGoals (working copy)
    modalGoals = goals.filter(g => g.match_id === matchId).map(g => ({
      player_id:   g.player_id,
      team_id:     g.team_id,
      is_own_goal: g.is_own_goal,
      player_name: g.player_id ? (players.find(p => p.id === g.player_id) || {}).name || '?' : '?',
    }));

    // Check if there are any players for these teams
    const homePlayers = players.filter(p => p.team_id === m.home_id);
    const awayPlayers = players.filter(p => p.team_id === m.away_id);
    const panel = document.getElementById('goalScorersPanel');

    if (homePlayers.length || awayPlayers.length) {
      panel.hidden = false;
      renderGoalScorers(m);
    } else {
      panel.hidden = true;
    }

    document.getElementById('modal').hidden = false;
    document.getElementById('modalHomeGoals').focus();
    document.getElementById('modalHomeGoals').select();
  }

  function renderGoalScorers(m) {
    const homePlayers = players.filter(p => p.team_id === m.home_id);
    const awayPlayers = players.filter(p => p.team_id === m.away_id);

    // Labels
    document.getElementById('gsHomeLabel').textContent = tName(m.home_id);
    document.getElementById('gsAwayLabel').textContent = tName(m.away_id);

    // Home players
    const hEl = document.getElementById('gsHomePlayers');
    hEl.innerHTML = homePlayers.length
      ? homePlayers.map(p =>
          `<button class="gs-player-btn" onclick="NML.addGoal(${p.id},${m.home_id},'${esc(p.name)}')" title="${esc(p.name)}">
            ${p.number ? `<b>#${p.number}</b> ` : ''}${esc(p.name)}
          </button>`).join('')
      : `<div class="gs-no-players">Нет игроков</div>`;

    // Away players
    const aEl = document.getElementById('gsAwayPlayers');
    aEl.innerHTML = awayPlayers.length
      ? awayPlayers.map(p =>
          `<button class="gs-player-btn" onclick="NML.addGoal(${p.id},${m.away_id},'${esc(p.name)}')" title="${esc(p.name)}">
            ${p.number ? `<b>#${p.number}</b> ` : ''}${esc(p.name)}
          </button>`).join('')
      : `<div class="gs-no-players">Нет игроков</div>`;

    updateGoalChips(m);
  }

  function addGoalToModal(playerId, teamId, playerName) {
    modalGoals.push({ player_id: playerId, team_id: teamId, player_name: playerName, is_own_goal: false });
    const m = matches.find(x => x.id === modalMatchId);
    if (m) updateGoalChips(m);
  }

  function removeGoalFromModal(idx) {
    modalGoals.splice(idx, 1);
    const m = matches.find(x => x.id === modalMatchId);
    if (m) updateGoalChips(m);
  }

  function updateGoalChips(m) {
    const hGoals = modalGoals.filter(g => g.team_id === m.home_id).length;
    const aGoals = modalGoals.filter(g => g.team_id === m.away_id).length;
    document.getElementById('gsCountBadge').textContent = modalGoals.length;

    // Chips
    const chips = document.getElementById('goalsChips');
    chips.innerHTML = modalGoals.length
      ? modalGoals.map((g, i) => {
          const isHome = g.team_id === m.home_id;
          const color  = isHome ? '#6c5ce7' : '#e17055';
          return `<span class="goal-chip">
            <span class="goal-chip-dot" style="background:${color}"></span>
            ${esc(g.player_name)}
            <button class="goal-chip-remove" onclick="NML.removeGoal(${i})">×</button>
          </span>`;
        }).join('')
      : '<span style="opacity:.35;font-size:.78rem">Нажмите на игрока выше, чтобы отметить гол</span>';

    // Mismatch warning
    const hScore = parseInt(document.getElementById('modalHomeGoals').value) || 0;
    const aScore = parseInt(document.getElementById('modalAwayGoals').value) || 0;
    const warn   = document.getElementById('gsMismatchWarn');
    const total  = hGoals + aGoals;
    if (modalGoals.length && (hGoals !== hScore || aGoals !== aScore)) {
      warn.hidden = false;
      warn.textContent = `⚠ Голов записано: ${hGoals}+${aGoals}=${total}, а счёт ${hScore}:${aScore}`;
    } else {
      warn.hidden = true;
    }
  }

  async function saveModal() {
    if (modalMatchId === null) return;
    const hg = Math.max(0, parseInt(document.getElementById('modalHomeGoals').value) || 0);
    const ag = Math.max(0, parseInt(document.getElementById('modalAwayGoals').value) || 0);

    const m = matches.find(x => x.id === modalMatchId);
    if (!m) return;

    if (m.match_type !== 'group' && hg === ag) {
      toast('В плей-офф ничья невозможна!');
      return;
    }

    // Save score
    const { error } = await db.from('matches')
      .update({ home_goals: hg, away_goals: ag, played: true })
      .eq('id', modalMatchId);
    if (error) { toast('Ошибка сохранения'); console.error(error); return; }

    // Save goals: delete old, insert new
    await db.from('goals').delete().eq('match_id', modalMatchId);
    if (modalGoals.length) {
      const rows = modalGoals.map(g => ({
        match_id:    modalMatchId,
        player_id:   g.player_id,
        team_id:     g.team_id,
        is_own_goal: g.is_own_goal || false,
      }));
      const { error: ge } = await db.from('goals').insert(rows);
      if (ge) console.error('Goal insert error', ge);
    }

    closeModal();
    await loadAll();
    toast('Результат сохранён');
    syncToSheets();
  }

  async function clearModal() {
    if (modalMatchId === null) return;
    const m = matches.find(x => x.id === modalMatchId);
    if (!m) return;

    await db.from('matches')
      .update({ home_goals: null, away_goals: null, played: false })
      .eq('id', modalMatchId);
    await db.from('goals').delete().eq('match_id', modalMatchId);

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

  function closeModal() {
    document.getElementById('modal').hidden = true;
    modalMatchId = null;
    modalGoals   = [];
  }

  /* =========================================================
     ACTIONS — Supabase writes
     ========================================================= */
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

    if (home_id === away_id) { toast('Команды должны быть разными'); return; }

    const played = Number.isInteger(hg) && Number.isInteger(ag);
    const { error } = await db.from('matches').insert([{
      match_type: 'group', slot: null, round: null,
      home_id, away_id,
      home_goals: played ? hg : null,
      away_goals: played ? ag : null,
      played,
    }]);
    if (error) { toast('Ошибка добавления матча'); console.error(error); return; }
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
          match_type: 'group', slot: null, round: tour + 1,
          home_id: swap ? b : a, away_id: swap ? a : b,
          home_goals: null, away_goals: null, played: false,
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
    await db.from('matches').delete().gt('id', 0);

    const rows = computeSchedule(seedVal);
    if (rows.length) {
      const { error } = await db.from('matches').insert(rows);
      if (error) { toast('Ошибка создания расписания'); console.error(error); document.getElementById('generateBtn').disabled = false; return; }
    }

    await db.from('settings').upsert({ key: 'seed', value: String(seedVal) });
    await loadAll();
    document.getElementById('generateBtn').disabled = false;
    toast('Расписание создано — ' + rows.length + ' матчей');
    document.querySelector('.nav-btn[data-tab="matches"]').click();
  }

  async function resetData() {
    if (!confirm('Все матчи будут удалены. Команды останутся. Продолжить?')) return;
    await db.from('matches').delete().gt('id', 0);
    await db.from('goals').delete().gt('id', 0);
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
    await loadAll(); toast('Стыковые матчи созданы');
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
    await loadAll(); toast('Четвертьфиналы созданы');
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
    await loadAll(); toast('Полуфиналы созданы');
  }

  async function createFinal() {
    const sf1w = winner(slotMatch('sf1')), sf2w = winner(slotMatch('sf2'));
    if (!sf1w || !sf2w) { toast('Сначала завершите полуфиналы'); return; }
    const row = { match_type: 'final', slot: 'final', round: null, home_id: sf1w, away_id: sf2w, played: false };
    const { error } = await db.from('matches').insert([row]);
    if (error) { toast('Ошибка создания финала'); console.error(error); return; }
    await loadAll(); toast('Финал создан!');
  }

  /* =========================================================
     IMPORT / EXPORT
     ========================================================= */
  function exportMatches() {
    const data = matches.map(m => ({
      match_type: m.match_type, slot: m.slot, round: m.round,
      home: tName(m.home_id), away: tName(m.away_id),
      home_goals: m.home_goals, away_goals: m.away_goals, played: m.played,
    }));
    downloadJSON(data, 'nml-matches.json');
    toast('Матчи скачаны');
  }

  async function importMatches(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch { toast('Ошибка чтения JSON'); return; }
    if (!Array.isArray(data) || !data.length) { toast('Файл пуст или неверный формат'); return; }

    const nameMap = {};
    teams.forEach(t => { nameMap[t.name.toLowerCase()] = t.id; });

    const missing = new Set();
    data.forEach(m => {
      if (!nameMap[(m.home||'').toLowerCase()]) missing.add(m.home);
      if (!nameMap[(m.away||'').toLowerCase()]) missing.add(m.away);
    });
    if (missing.size) { toast('Не найдены команды: ' + [...missing].join(', ')); return; }

    if (!confirm(`Импорт ${data.length} матчей. Все текущие матчи будут заменены. Продолжить?`)) return;

    await db.from('matches').delete().gt('id', 0);

    const rows = data.map(m => ({
      match_type: m.match_type || 'group', slot: m.slot || null, round: m.round || null,
      home_id: nameMap[m.home.toLowerCase()], away_id: nameMap[m.away.toLowerCase()],
      home_goals: m.played !== false && m.home_goals != null ? m.home_goals : null,
      away_goals: m.played !== false && m.away_goals != null ? m.away_goals : null,
      played:     m.played !== false && m.home_goals != null && m.away_goals != null,
    }));

    const { error } = await db.from('matches').insert(rows);
    if (error) { toast('Ошибка импорта матчей'); console.error(error); return; }
    await loadAll();
    toast('Импортировано ' + rows.length + ' матчей');
  }

  function exportTable() {
    const st = customTable || getStandings();
    const data = st.map((r, i) => ({
      pos: i+1, name: r.name, p: r.p, w: r.w, d: r.d, l: r.l,
      gs: r.gs, gc: r.gc, gd: r.gd != null ? r.gd : r.gs - r.gc, pts: r.pts,
    }));
    downloadJSON(data, 'nml-table.json');
    toast('Таблица скачана');
  }

  async function importTable(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch { toast('Ошибка чтения JSON'); return; }
    if (!Array.isArray(data) || !data.length) { toast('Файл пуст или неверный формат'); return; }

    const teamMap = {};
    teams.forEach(t => { teamMap[t.name.toLowerCase()] = t.name; });

    const missing = [];
    customTable = data.map(r => {
      const realName = teamMap[r.name.toLowerCase()];
      if (!realName) missing.push(r.name);
      return { name: realName || r.name, p: r.p, w: r.w, d: r.d, l: r.l, gs: r.gs, gc: r.gc, gd: r.gd != null ? r.gd : r.gs - r.gc, pts: r.pts };
    });

    if (missing.length) { toast('Не найдены команды: ' + missing.join(', ')); customTable = null; return; }

    customTable.sort((a,b) => b.pts - a.pts || b.gd - a.gd || b.gs - a.gs || a.name.localeCompare(b.name));

    await db.from('settings').upsert({ key: 'custom_table', value: JSON.stringify(customTable) });
    render();
    toast('Таблица загружена');
  }

  async function clearCustomTable() {
    customTable = null;
    await db.from('settings').delete().eq('key', 'custom_table');
    render();
    toast('Загруженная таблица сброшена');
  }

  function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* =========================================================
     AUTH
     ========================================================= */
  function initAuth() {
    const lockBtn = document.getElementById('lockBtn');
    const codeBox = document.getElementById('codeBox');
    const codeInp = document.getElementById('adminCode');

    lockBtn.addEventListener('click', () => {
      if (isAdmin) { logout(); return; }
      const show = codeBox.hidden;
      codeBox.hidden = !show;
      if (show) { codeInp.value = ''; codeInp.focus(); }
    });

    codeInp.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        if (codeInp.value === ADMIN_CODE) { login(); }
        else { toast('Неверный код'); codeInp.value = ''; }
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
    document.querySelector('.nav-btn[data-tab="admin"]').click();
  }

  function logout() {
    isAdmin = false;
    sessionStorage.removeItem('nml_admin');
    applyAdminMode();
    document.querySelector('.nav-btn[data-tab="table"]').click();
    toast('Вы вышли из админ-режима');
  }

  function applyAdminMode() {
    document.body.classList.toggle('admin-mode', isAdmin);
    const adminTabBtn = document.querySelector('.nav-btn[data-tab="admin"]');
    adminTabBtn.style.display = isAdmin ? '' : 'none';
    document.getElementById('lockBtn').textContent = isAdmin ? '🔓' : '🔒';
    document.getElementById('lockBtn').title = isAdmin ? 'Выйти из админ-режима' : 'Вход для администратора';
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
    document.getElementById('addMatchBtn')?.addEventListener('click', addManualMatch);

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
    document.getElementById('modalHomeGoals').addEventListener('keydown', e => {
      if (e.key === 'Enter') saveModal();
      // update mismatch warning on change
    });
    document.getElementById('modalAwayGoals').addEventListener('keydown', e => {
      if (e.key === 'Enter') saveModal();
    });
    // Update mismatch warn when score changes
    ['modalHomeGoals', 'modalAwayGoals'].forEach(id => {
      document.getElementById(id).addEventListener('input', () => {
        const m = matches.find(x => x.id === modalMatchId);
        if (m && !document.getElementById('goalScorersPanel').hidden) updateGoalChips(m);
      });
    });
  }

  /* =========================================================
     GOOGLE SHEETS SYNC
     ========================================================= */
  async function syncToSheets() {
    try {
      const standings = getStandings();
      const played = matches.filter(m => m.played).map(m => ({
        type: m.match_type, round: m.round,
        home: tName(m.home_id), homeGoals: m.home_goals,
        awayGoals: m.away_goals, away: tName(m.away_id),
      }));
      const order = { group: 0, qual: 1, qf: 2, sf: 3, final: 4 };
      played.sort((a,b) => (order[a.type]||0) - (order[b.type]||0) || (a.round||0) - (b.round||0));
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
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
     PUBLIC API
     ========================================================= */
  window.NML = {
    open:               openModal,
    rename:             renameTeam,
    createQual:         createQual,
    createQF:           createQF,
    createSF:           createSF,
    createFinal:        createFinal,
    logout:             logout,
    exportMatches:      exportMatches,
    exportTable:        exportTable,
    clearCustomTable:   clearCustomTable,
    // Team modal
    openTeam:           openTeamModal,
    closeTeam:          closeTeamModal,
    toggleAddPlayer:    toggleAddPlayerForm,
    addPlayer:          addPlayer,
    removePlayer:       removePlayer,
    promptLogoUpload:   promptLogoUpload,
    // Goal scorers
    addGoal:            addGoalToModal,
    removeGoal:         removeGoalFromModal,
    // Players tab
    filterPlayers:      (v) => { playerFilter = v || ''; renderPlayersTab(); },
  };

})();