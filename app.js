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
  let matches     = [];   // [{id, match_type, slot, round, home_id, away_id, home_goals, away_goals, played, is_technical}]
  let settings    = {};
  let players     = [];   // [{id, team_id, name, number, sort_order}]
  let goals       = [];   // [{id, match_id, player_id, team_id, minute, assist_player_id, is_own_goal}]
  let isAdmin     = sessionStorage.getItem('nml_admin') === '1';
  let customTable = null;

  let teamMap = {};
  let goalMap = {};

  let currentTeamId  = null;
  let currentTeamTab = 'roster'; // 'roster' | 'matches'
  let expandedPlayerId = null;

  // Team page state
  let teamPageId  = null;
  let teamPageTab = 'roster';

  // Match modal state
  let modalMatchId = null;
  // modalGoals: [{player_id, team_id, player_name, minute, assist_player_id, assist_name, is_own_goal}]
  let modalGoals   = [];
  let goalSide     = 'home'; // 'home' | 'away'

  let playerFilter = '';
  let playerSort   = 'goals'; // 'goals'|'assists'|'ga'
  let playerSearch = '';

  let matchFilterPlayed = true;
  let matchFilterUnplayed = true;

  /* =========================================================
     BOOTSTRAP
     ========================================================= */
  document.addEventListener('DOMContentLoaded', async () => {
    initTabs();
    initAdmin();
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
      document.getElementById('loading').style.display = 'none';
      document.getElementById('app').style.display = '';
    }
  });

  /* =========================================================
     DATA
     ========================================================= */
async function loadAll() {
  console.time('teams');
  // Исправлено: все колонки в одной строке 'id, name, sort_order, logo'
  const tRes = await db.from('teams')
    .select('id, name, sort_order, logo') 
    .limit(10)
    .order('sort_order');
  console.timeEnd('teams');

  console.time('matches');
  const mRes = await db.from('matches')
    .select('id, match_type, round, match_date, home_id, away_id, home_goals, away_goals, played, is_technical')
    .limit(10)
    .order('id');
  console.timeEnd('matches');

  console.time('players');
  // Исправлено: добавлены photo и number в общую строку
  const pRes = await db.from('players')
    .select('id, name, team_id, sort_order, number, photo')
    .limit(10)
    .order('sort_order')
    .order('id');
  console.timeEnd('players');

  console.time('goals');
  const gRes = await db.from('goals')
    .select('id, match_id, player_id')
    .limit(10)
    .order('id');
  console.timeEnd('goals');

  console.time('settings');
  const sRes = await db.from('settings').select('key, value');
  console.timeEnd('settings');

  if (tRes.error || mRes.error || pRes.error || gRes.error || sRes.error) {
    console.error('Load error', tRes.error, mRes.error, pRes.error, gRes.error, sRes.error);
    return;
  }

  teams = tRes.data || [];
  matches = mRes.data || [];
  players = pRes.data || [];
  goals = gRes.data || [];

  settings = {};
  (sRes.data || []).forEach(r => {
    settings[r.key] = r.value;
  });

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

      teamMap = {};
      teams.forEach(t => {
        teamMap[t.id] = t;
      });
    
      goalMap = {};
      goals.forEach(g => {
        goalMap[g.match_id] = (goalMap[g.match_id] || 0) + 1;
      });
    
    renderStats();
    renderTable();
    renderMatches();
    renderClubs();
    renderHallOfFame();
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
    const gcount = goals.filter(g => {
      const m = matches.find(x => x.id === g.match_id);
      return m && m.match_type === 'group' && m.played;
    }).length;
    document.getElementById('statTeams').textContent     = teams.length;
    document.getElementById('statPlayed').textContent    = played;
    document.getElementById('statGoals').textContent     = gcount;
    document.getElementById('statRemaining').textContent = Math.max(0, total - played);
  }

  /* ---------- League table ---------- */
  function getStandings() {
    const map = {};
    teams.forEach(t => {
      map[t.id] = { id:t.id, name:t.name, p:0, w:0, d:0, l:0, gs:0, gc:0, gd:0, pts:0, form:[] };
    });
    const playedGroup = matches
      .filter(m => m.match_type === 'group' && m.played)
      .sort((a,b) => (a.round||0) - (b.round||0) || a.id - b.id);
    playedGroup.forEach(m => {
      const h = map[m.home_id], a = map[m.away_id];
      if (!h || !a) return;
      h.p++; a.p++;
      h.gs += m.home_goals; h.gc += m.away_goals;
      a.gs += m.away_goals; a.gc += m.home_goals;
      h.gd = h.gs - h.gc;  a.gd = a.gs - a.gc;
      if (m.home_goals > m.away_goals)      { h.w++; h.pts += 3; a.l++; h.form.push('W'); a.form.push('L'); }
      else if (m.home_goals < m.away_goals) { a.w++; a.pts += 3; h.l++; h.form.push('L'); a.form.push('W'); }
      else                                  { h.d++; h.pts++;    a.d++; a.pts++; h.form.push('D'); a.form.push('D'); }
    });
    return Object.values(map).sort((a,b) =>
      b.pts - a.pts || b.gd - a.gd || b.gs - a.gs || a.name.localeCompare(b.name)
    );
  }

  function teamLogoHTML(teamId, cls='team-logo-sm', phCls='team-logo-placeholder-sm') {
    const t = teams.find(x => x.id === teamId);
    if (t && t.logo) return `<img src="${esc(t.logo)}" class="${cls}" alt="">`;
    return `<span class="${phCls}">⚽</span>`;
  }

  function formBadgeHTML(results) {
    const last5 = results.slice(-5);
    const badges = last5.map(res => {
      if (res === 'W') return '<span class="form-w">В</span>';
      if (res === 'D') return '<span class="form-d">Н</span>';
      return '<span class="form-l">П</span>';
    });
    while (badges.length < 5) badges.unshift('<span class="form-ph">·</span>');
    return badges.join('');
  }

  function renderTable() {
    const standings = getStandings();
    const st = customTable || standings;
    const formMap = {};
    standings.forEach(r => { formMap[r.id] = r.form || []; });
    document.getElementById('tableBody').innerHTML = st.map((r, i) => {
      const pos   = i + 1;
      const cls   = pos <= 6 ? 'zone-playoff-row' : pos <= 10 ? 'zone-qual-row' : 'zone-out-row';
      const gd    = (r.gd != null ? r.gd : r.gs - r.gc);
      const gdStr = gd > 0 ? '+' + gd : gd;
      const tid   = r.id || (teams.find(t => t.name === r.name) || {}).id;
      const logo  = teamLogoHTML(tid);
      const click = tid ? `onclick="NML.openTeamPage(${tid})"` : '';
      const cs    = tid ? 'style="cursor:pointer"' : 'style="cursor:default"';
      const form  = formBadgeHTML(formMap[tid] || []);
      return `<tr class="${cls}">
        <td class="col-pos">${pos}</td>
        <td class="col-team" ${click} ${cs}>
          <div class="team-cell">${logo}<span class="team-cell-name">${esc(r.name)}</span></div>
        </td>
        <td class="col-p">${r.p}</td>
        <td class="col-secondary">${r.w}</td><td class="col-secondary">${r.d}</td><td class="col-secondary">${r.l}</td>
        <td class="col-secondary">${r.gs}</td><td class="col-secondary">${r.gc}</td><td class="col-secondary">${gdStr}</td>
        <td class="col-pts">${r.pts}</td>
        <td class="col-form">${form}</td></tr>`;
    }).join('');
  }

  /* ---------- Matches tab ---------- */
function renderMatches() {
  const el = document.getElementById('matchdays');
  const group = matches.filter(m => m.match_type === 'group');

  if (!group.length) {
    el.innerHTML = '<div class="no-schedule"><p>Нет матчей</p></div>';
    return;
  }

  const rounds = {};
  group.forEach(m => {
    const key = m.round != null ? m.round : 'unassigned';
    (rounds[key] = rounds[key] || []).push(m);
  });

  const roundKeys = Object.keys(rounds)
    .filter(k => k !== 'unassigned')
    .sort((a, b) => a - b);

  // Добавляем матчи без тура в конец
  if (rounds['unassigned']) roundKeys.push('unassigned');

  const html = roundKeys.map(r => {
    const list = rounds[r];
    const sorted = list.sort((a, b) => {
      if (a.played !== b.played) return a.played ? -1 : 1;
      return a.id - b.id;
    });
    const label = r === 'unassigned' ? '—' : r;
    return `
      <div class="matchday">
        <div class="matchday-header">Тур ${label}</div>
        <div class="match-grid">
          ${sorted.map(m => matchCardHTML(m)).join('')}
        </div>
      </div>
    `;
  }).join('');

  el.innerHTML = html;
}

function matchCardHTML(m) {
  const home = teamMap[m.home_id];
  const away = teamMap[m.away_id];

  const homeLogo = teamLogoHTML(m.home_id, 'match-card-logo', 'logo-ph');
  const awayLogo = teamLogoHTML(m.away_id, 'match-card-logo', 'logo-ph');

  const hName = home ? home.name : '—';
  const aName = away ? away.name : '—';

  const score = m.played
    ? `${m.home_goals} : ${m.away_goals}`
    : '— : —';

  const pCls = m.played
    ? (m.is_technical ? ' played tp' : ' played')
    : '';

  const hW = m.played && m.home_goals > m.away_goals ? ' match-winner' : '';
  const aW = m.played && m.away_goals > m.home_goals ? ' match-winner' : '';

  const gCount = goalMap[m.id] || 0;

  const gTag = (m.played && gCount > 0 && !m.is_technical)
    ? `<span class="match-goal-count">⚽ ${gCount}</span>`
    : '';

  const tpTag = m.is_technical
    ? `<span class="match-tp-badge">ТП</span>`
    : '';

  const clickable = isAdmin || m.played;
  const cursor = clickable ? '' : 'style="cursor:default"';
  const onclick = clickable ? `onclick="NML.open(${m.id})"` : '';

  return `
    <div class="match-card${pCls}" ${onclick} ${cursor}>
      <div class="match-team-info home-side">
        ${homeLogo}
        <span class="match-home${hW}">${esc(hName)}</span>
      </div>
      
      <div class="match-score-block">
        <span class="match-score">${score}</span>
        ${tpTag} ${gTag}
      </div>

      <div class="match-team-info away-side">
        <span class="match-away${aW}">${esc(aName)}</span>
        ${awayLogo}
      </div>
    </div>
  `;
}

  /* ---------- Players Tab ---------- */
  function fillTeamFilter() {
    const sel = document.getElementById('playerTeamFilter');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">Все команды</option>' +
      teams.map(t => `<option value="${t.id}" ${String(t.id) === current ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  }

  /* ── Sort definitions ── */

  function setPlayerSort(s) {
    playerSort = s;
    renderPlayersTab();
  }

  function renderPlayersTab() {
    const el = document.getElementById('playersList');
    if (!el) return;

    // Update sort chip active states (chips are static DOM, just toggle class)
    document.querySelectorAll('#sortBar .sort-chip').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.sort === playerSort);
    });

    // Show/hide search clear button
    const clearBtn = document.getElementById('searchClearBtn');
    if (clearBtn) clearBtn.style.display = playerSearch ? '' : 'none';

    // Build stats maps (exclude own goals and TP matches)
    const goalMap    = {};
    const assistMap  = {};
    goals.forEach(g => {
      const m = matches.find(x => x.id === g.match_id);
      if (!m || m.is_technical) return;
      if (g.player_id && !g.is_own_goal)
        goalMap[g.player_id]   = (goalMap[g.player_id]   || 0) + 1;
      if (g.assist_player_id)
        assistMap[g.assist_player_id] = (assistMap[g.assist_player_id] || 0) + 1;
    });

    const allPlayers = players.filter(p => {
      if (playerFilter && String(p.team_id) !== String(playerFilter)) return false;
      if (playerSearch) {
        const q    = playerSearch.toLowerCase();
        const name = (p.name || '').toLowerCase();
        // Tokenise: search as one continuous string and also check each token
        if (!name.includes(q)) {
          // Try matching across tokens: "ива ал" should match "Иванов Александр"
          const tokens = name.split(/\s+/);
          const joined = tokens.join(''); // "ивановалександр"
          const qNoSp  = q.replace(/\s+/g, '');
          if (!joined.includes(qNoSp)) return false;
        }
      }
      return true;
    });

    if (!allPlayers.length) {
      el.innerHTML = `<div class="players-empty">
        <div class="empty-icon">👥</div>
        <p>${playerFilter ? 'В этой команде пока нет игроков' : 'Игроки ещё не добавлены'}</p>
        ${isAdmin ? '<p style="margin-top:8px;font-size:.8rem;opacity:.5">Откройте команду из таблицы и добавьте состав</p>' : ''}
      </div>`;
      return;
    }

    /* Sort */
    const sorted = [...allPlayers].sort((a, b) => {
      const ga = goalMap[a.id]   || 0, gb = goalMap[b.id]   || 0;
      const aa = assistMap[a.id] || 0, ab = assistMap[b.id] || 0;
      switch (playerSort) {
        case 'goals':
          return gb !== ga ? gb - ga : ab - aa || (a.name||'').localeCompare(b.name||'');
        case 'assists':
          return ab !== aa ? ab - aa : gb - ga || (a.name||'').localeCompare(b.name||'');
        case 'ga':
          const sumA = ga + aa, sumB = gb + ab;
          return sumB !== sumA ? sumB - sumA : gb - ga || (a.name||'').localeCompare(b.name||'');
        default:
          return gb - ga;
      }
    });



    /* Primary stat column depends on sort */
    const getPrimary = (g, a) => {
      if (playerSort === 'assists') return { val: a, label: `ассист${a===1?'':a<5&&a>1?'а':'ов'}` };
      if (playerSort === 'ga')     return { val: g+a, label: 'очков' };
      return { val: g, label: `гол${g===1?'':g<5&&g>1?'а':'ов'}` };
    };

    const rows = sorted.map((p, i) => {
      const team    = teams.find(t => t.id === p.team_id) || {};
      const g       = goalMap[p.id]   || 0;
      const a       = assistMap[p.id] || 0;
      const logo    = team.logo
        ? `<img src="${esc(team.logo)}" class="scorer-logo-sm" alt="">`
        : `<div class="scorer-logo-placeholder">⚽</div>`;
      const rank    = i + 1;
      const rankCls = rank <= 3 ? ' top' : '';
      const numTxt  = p.number ? ` <span class="player-num-tag">#${p.number}</span>` : '';
      const primary = getPrimary(g, a);

      /* Secondary stats (the other two) */
      const secondaries = [];
      if (playerSort !== 'goals'   && playerSort !== 'ga') secondaries.push(`<span class="sec-stat" title="Голы">⚽ ${g}</span>`);
      if (playerSort !== 'assists' && playerSort !== 'ga') secondaries.push(`<span class="sec-stat" title="Ассисты">👟 ${a}</span>`);
      if (playerSort === 'ga') {
        secondaries.push(`<span class="sec-stat" title="Голы">⚽ ${g}</span>`);
        secondaries.push(`<span class="sec-stat" title="Ассисты">👟 ${a}</span>`);
      }
      const secHTML = secondaries.length
        ? `<div class="sec-stats-row">${secondaries.join('')}</div>` : '';

      return `<div class="scorer-row">
        <div class="scorer-rank${rankCls}">${rank}</div>
        ${logo}
        <div class="scorer-info">
          <div class="scorer-name">${esc(p.name)}${numTxt}</div>
          <div class="scorer-team-name">${esc(team.name || '')}</div>
          ${secHTML}
        </div>
        <div class="scorer-primary-col">
          <span class="primary-val">${primary.val}</span>
          <span class="primary-label">${primary.label}</span>
        </div>
      </div>`;
    }).join('');

    el.innerHTML = `<div class="scorers-list">${rows}</div>`;
  }

  /* ---------- Clubs tab ---------- */
  function renderClubs() {
    const el = document.getElementById('clubsGrid');
    if (!el) return;
    const standings = getStandings();
    if (!teams.length) { el.innerHTML = '<p style="color:var(--muted);text-align:center;padding:40px">Команды не добавлены</p>'; return; }
    el.innerHTML = standings.map((r, i) => {
      const pos  = i + 1;
      const tid  = r.id || (teams.find(t => t.name === r.name) || {}).id;
      const logo = teamLogoHTML(tid, 'club-card-logo', 'club-card-logo-ph');
      const gdStr = (r.gd >= 0 ? '+' : '') + r.gd;
      return `<div class="club-card" onclick="NML.openTeamPage(${tid})">
        <div class="club-card-top">
          <span class="club-card-pos">${pos}</span>
          ${logo}
          <span class="club-card-name">${esc(r.name)}</span>
        </div>
        <div class="club-card-stats">
          <div class="club-stat"><span class="club-stat-val">${r.p}</span><span class="club-stat-lbl">Игры</span></div>
          <div class="club-stat"><span class="club-stat-val">${r.w}</span><span class="club-stat-lbl">Победы</span></div>
          <div class="club-stat"><span class="club-stat-val">${r.l}</span><span class="club-stat-lbl">Поражения</span></div>
          <div class="club-stat"><span class="club-stat-val club-stat-gd">${gdStr}</span><span class="club-stat-lbl">РМ</span></div>
          <div class="club-stat"><span class="club-stat-val club-stat-pts">${r.pts}</span><span class="club-stat-lbl">Очки</span></div>
        </div>
      </div>`;
    }).join('');
  }

  /* ---------- Hall of Fame tab ---------- */
  function getHofMembers() {
    try { return JSON.parse(settings.hof_members || '[]'); } catch { return []; }
  }

  function renderHallOfFame() {
    const el = document.getElementById('hofContent');
    if (!el) return;

    const members = getHofMembers();
    if (!members.length) {
      el.innerHTML = '<p class="hof-empty">Зал Славы пока пуст</p>';
      return;
    }

    // Group by year descending
    const byYear = {};
    members.forEach(m => {
      const y = m.year || '—';
      if (!byYear[y]) byYear[y] = [];
      byYear[y].push(m);
    });
    const years = Object.keys(byYear).sort((a, b) => b - a);

    el.innerHTML = years.map(year => `
      <div class="hof-year-block">
        <div class="hof-year-header">
          <div class="hof-year-line"></div>
          <div class="hof-year-badge">✦ ВЫПУСК ${esc(String(year))} ✦</div>
          <div class="hof-year-line"></div>
        </div>
        <div class="hof-year-decree">В Hall of Fame вошли:</div>
        <div class="hof-entries">
          ${byYear[year].map(m => {
            const initials = (m.name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
            const photoEl = m.photo
              ? `<img src="${esc(m.photo)}" class="hof-portrait" alt="${esc(m.name)}">`
              : `<div class="hof-portrait-ph">${initials}</div>`;
            return `<div class="hof-entry">
  ${photoEl}
  <div class="hof-entry-ornament">⸻ ✦ ⸻</div>
  <div class="hof-entry-name">${esc(m.name)}</div>
  ${m.description ? `<div class="hof-entry-desc">&ldquo;${esc(m.description)}&rdquo;</div>` : ''}
</div>`;
          }).join('')}
        </div>
      </div>`
    ).join('');
  }

  /* ---------- HoF admin functions ---------- */
  function renderAdminHof() {
    const el = document.getElementById('hofAdminList');
    if (!el) return;
    const members = getHofMembers();
    if (!members.length) {
      el.innerHTML = '<p style="opacity:.5;font-size:.85rem">Список пуст</p>';
      return;
    }
    // Group by year descending for admin list too
    const byYear = {};
    members.forEach((m, i) => {
      const y = m.year || '—';
      if (!byYear[y]) byYear[y] = [];
      byYear[y].push({ name: m.name, desc: m.description, photo: m.photo, idx: i });
    });
    const years = Object.keys(byYear).sort((a, b) => b - a);
    el.innerHTML = years.map(year => `
      <div class="hof-admin-year-group">
        <div class="hof-admin-year-label">Выпуск ${esc(String(year))}</div>
        ${byYear[year].map(entry => {
          const initials = (entry.name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
          const thumb = entry.photo
            ? `<img src="${esc(entry.photo)}" class="hof-admin-thumb" onclick="NML.changeHofPhoto(${entry.idx})" title="Сменить фото">`
            : `<div class="hof-admin-thumb hof-admin-thumb-ph" onclick="NML.changeHofPhoto(${entry.idx})" title="Загрузить фото">${initials}</div>`;
          return `<div class="hof-admin-row">
            ${thumb}
            <div class="hof-admin-entry-info">
              <span class="hof-admin-name">${esc(entry.name)}</span>
              ${entry.desc ? `<span class="hof-admin-desc">${esc(entry.desc)}</span>` : ''}
            </div>
            <button class="btn-sm-danger" onclick="NML.removeFromHof(${entry.idx})">✕</button>
          </div>`;
        }).join('')}
      </div>`
    ).join('');
  }

  async function addToHof() {
    const nameInp  = document.getElementById('hofName');
    const yearInp  = document.getElementById('hofYear');
    const descInp  = document.getElementById('hofDesc');
    const phoneInp = document.getElementById('hofPhone');
    const photoInp = document.getElementById('hofPhoto');
    const name = nameInp.value.trim();
    const year = parseInt(yearInp.value);
    const description = descInp.value.trim();
    const phone = phoneInp.value.trim();
    if (!name) { toast('Введите ФИО'); return; }
    if (!year) { toast('Введите год выпуска'); return; }

    const file = photoInp.files[0];
    const readPhoto = file
      ? await new Promise(resolve => {
          const r = new FileReader();
          r.onload = e => resolve(e.target.result);
          r.readAsDataURL(file);
        })
      : null;

    const members = getHofMembers();
    members.push({
      name, year,
      ...(description && { description }),
      ...(phone       && { phone }),
      ...(readPhoto   && { photo: readPhoto }),
    });
    const { error } = await db.from('settings')
      .upsert({ key: 'hof_members', value: JSON.stringify(members) });
    if (error) { toast('Ошибка сохранения'); console.error(error); return; }

    nameInp.value  = '';
    yearInp.value  = '';
    descInp.value  = '';
    phoneInp.value = '';
    photoInp.value = '';
    document.getElementById('hofPhotoPreview').hidden = true;
    await loadAll();
    renderHallOfFame();
    renderAdminHof();
    toast('Добавлен в Зал Славы');
  }

  function changeHofPhoto(index) {
    if (!isAdmin) return;
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = async e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async ev => {
        const members = getHofMembers();
        if (!members[index]) return;
        members[index].photo = ev.target.result;
        const { error } = await db.from('settings')
          .upsert({ key: 'hof_members', value: JSON.stringify(members) });
        if (error) { toast('Ошибка загрузки фото'); console.error(error); return; }
        await loadAll();
        renderHallOfFame();
        renderAdminHof();
        toast('Фото обновлено');
      };
      reader.readAsDataURL(file);
    };
    inp.click();
  }

  async function removeFromHof(index) {
    const members = getHofMembers();
    members.splice(index, 1);
    const { error } = await db.from('settings')
      .upsert({ key: 'hof_members', value: JSON.stringify(members) });
    if (error) { toast('Ошибка удаления'); console.error(error); return; }
    await loadAll();
    renderHallOfFame();
    renderAdminHof();
    toast('Удалён из Зала Славы');
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
        <div class="playoff-progress"><div class="playoff-progress-bar" style="width:${pct}%"></div></div></div>`;
      return;
    }

    const st = getStandings();
    const q1 = slotMatch('q1'), q2 = slotMatch('q2');
    let html = `<div class="playoff-section"><h2>Стыковые матчи (7-10 места)</h2><div class="qual-matches">`;
    html += bracketHTML(q1, st[6], st[9], 'q1');
    html += bracketHTML(q2, st[7], st[8], 'q2');
    html += `</div></div>`;
    if (!q1 && !q2 && isAdmin)
      html += `<div style="text-align:center;margin-bottom:24px"><button class="btn-accent" onclick="NML.createQual()">Сформировать стыковые матчи</button></div>`;

    const q1w = winner(q1), q2w = winner(q2);
    const qualDone = q1 && q2 && q1.played && q2.played;
    const qf1 = slotMatch('qf1'), qf2 = slotMatch('qf2'), qf3 = slotMatch('qf3'), qf4 = slotMatch('qf4');
    const sf1 = slotMatch('sf1'), sf2 = slotMatch('sf2');
    const fin = slotMatch('final');

    html += `<div class="playoff-section"><h2>Плей-офф (Сингл элиминейшн)</h2>`;
    if (qualDone && !qf1 && isAdmin)
      html += `<div style="text-align:center;margin-bottom:16px"><button class="btn-accent" onclick="NML.createQF()">Сформировать четвертьфиналы</button></div>`;
    const qfDone = qf1?.played && qf2?.played && qf3?.played && qf4?.played;
    if (qfDone && !sf1 && isAdmin)
      html += `<div style="text-align:center;margin-bottom:16px"><button class="btn-accent" onclick="NML.createSF()">Сформировать полуфиналы</button></div>`;
    const sfDone = sf1?.played && sf2?.played;
    if (sfDone && !fin && isAdmin)
      html += `<div style="text-align:center;margin-bottom:16px"><button class="btn-accent" onclick="NML.createFinal()">Сформировать финал</button></div>`;

    html += `<div class="bracket">`;
    html += `<div class="bracket-round"><div class="bracket-round-title">Четвертьфинал</div>`;
    html += bracketHTML(qf1, st[0], q2w !== null ? {id:q2w,name:tName(q2w)} : null, 'qf1');
    html += bracketHTML(qf2, st[3], st[4], 'qf2');
    html += bracketHTML(qf3, st[1], q1w !== null ? {id:q1w,name:tName(q1w)} : null, 'qf3');
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
    return w !== null ? {id:w, name:tName(w)} : null;
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
      const onclick = isAdmin ? `onclick="NML.open(${m.id})"` : '';
      return `<div class="bracket-match" ${onclick}>
        <div class="bracket-team"><span class="team-name">${esc(tName(m.home_id))}</span><span class="team-score"></span></div>
        <div class="bracket-team"><span class="team-name">${esc(tName(m.away_id))}</span><span class="team-score"></span></div></div>`;
    }
    const hTbd = homeObj ? '' : ' tbd', aTbd = awayObj ? '' : ' tbd';
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
        ? `<img src="${esc(t.logo)}" class="team-item-logo" onclick="NML.promptLogoUpload(${t.id})">`
        : `<div class="team-item-logo-ph" onclick="NML.promptLogoUpload(${t.id})">⚽</div>`;
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
    renderAdminHof();
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
    // All users can view roster; admin can also edit
    currentTeamId    = teamId;
    currentTeamTab   = 'roster';
    expandedPlayerId = null;
    renderTeamModal();
    document.getElementById('teamModal').hidden = false;
  }

  function switchTeamTab(tab) {
    currentTeamTab   = tab;
    expandedPlayerId = null;
    document.querySelectorAll('.tm-tab-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === tab)
    );
    document.getElementById('tmTabRoster').style.display  = tab === 'roster'  ? '' : 'none';
    document.getElementById('tmTabMatches').style.display = tab === 'matches' ? '' : 'none';
    if (tab === 'roster')  renderRoster();
    if (tab === 'matches') renderTeamMatches();
  }

  function closeTeamModal() {
    document.getElementById('teamModal').hidden = true;
    currentTeamId = null;
  }

  function renderTeamModal() {
    const t = teams.find(x => x.id === currentTeamId);
    if (!t) return;
    document.getElementById('tmTitle').textContent = t.name;
    const img = document.getElementById('tmLogoImg');
    const ph  = document.getElementById('tmLogoPlaceholder');
    if (t.logo) { img.src = t.logo; img.hidden = false; ph.hidden = true; }
    else        { img.hidden = true;  ph.hidden = false; }

    const st        = getStandings().find(r => r.id === currentTeamId) || {};
    const teamGoals = goals.filter(g => g.team_id === currentTeamId && !g.is_own_goal).length;
    const pCount    = players.filter(p => p.team_id === currentTeamId).length;
    const mPlayed   = matches.filter(m =>
      m.played && (m.home_id === currentTeamId || m.away_id === currentTeamId)
    ).length;

    document.getElementById('tmMeta').innerHTML =
      `<span class="meta-item">📋 ${pCount} игрок${pCount===1?'':pCount<5?'а':'ов'}</span>` +
      `<span class="meta-item">🏟 ${mPlayed} матч${mPlayed===1?'':mPlayed<5&&mPlayed>1?'а':'ей'}</span>` +
      (st.pts != null ? `<span class="meta-item">🏆 ${st.pts} очков</span>` : '') +
      `<span class="meta-item">⚽ ${teamGoals} гол${teamGoals===1?'':teamGoals<5&&teamGoals>1?'а':'ов'}</span>`;

    // Render tab bar into body placeholder
    const bodyEl = document.getElementById('tmTabsBody');
    if (bodyEl) {
      const addBtn = isAdmin
        ? `<button class="btn-add-player" onclick="NML.toggleAddPlayer()">+ Игрок</button>`
        : '';
      bodyEl.innerHTML = `
        <div class="tm-tab-bar">
          <button class="tm-tab-btn active" data-tab="roster"  onclick="NML.switchTab('roster')">👥 Состав</button>
          <button class="tm-tab-btn"        data-tab="matches" onclick="NML.switchTab('matches')">🏟 Матчи</button>
          <span class="tm-tab-spacer"></span>
          ${addBtn}
        </div>
        <div id="tmTabRoster"></div>
        <div id="tmTabMatches" style="display:none"></div>`;
    }
    renderRoster();
  }

  /* ── Team matches tab ── */
  function renderTeamMatches() {
    const el = document.getElementById('tmTabMatches');
    if (!el) return;

    const teamMatches = matches.filter(m =>
      m.played && (m.home_id === currentTeamId || m.away_id === currentTeamId)
    ).sort((a,b) => {
      // Sort: group by round first, then playoff stages
      const order = { group:0, qual:1, qf:2, sf:3, final:4 };
      const oa = order[a.match_type] ?? 0, ob = order[b.match_type] ?? 0;
      if (oa !== ob) return oa - ob;
      return (a.round||0) - (b.round||0);
    });

    if (!teamMatches.length) {
      el.innerHTML = '<div class="no-players-msg">Сыгранных матчей пока нет</div>';
      return;
    }

    const rows = teamMatches.map(m => {
      const isHome   = m.home_id === currentTeamId;
      const oppId    = isHome ? m.away_id : m.home_id;
      const myG      = isHome ? m.home_goals : m.away_goals;
      const oppG     = isHome ? m.away_goals : m.home_goals;
      const won      = myG > oppG, drew = myG === oppG, lost = myG < oppG;
      const resCls   = m.is_technical
        ? 'tm-res tp'
        : (won ? 'tm-res win' : drew ? 'tm-res draw' : 'tm-res loss');
      const resTxt   = m.is_technical
        ? 'ТП'
        : (won ? 'П' : drew ? 'Н' : 'П');
      // Won label: В (win), Н (draw), П (loss)
      const resultLabel = m.is_technical
        ? 'ТП'
        : (won ? 'В' : drew ? 'Н' : 'П');
      const resBadgeCls = m.is_technical ? 'tm-res tp' : (won ? 'tm-res win' : drew ? 'tm-res draw' : 'tm-res loss');

      const oppTeam = teams.find(x => x.id === oppId) || {};
      const oppLogo = oppTeam.logo
        ? `<img src="${esc(oppTeam.logo)}" class="team-logo-sm" alt="">`
        : `<span class="team-logo-placeholder-sm">⚽</span>`;
      const homeAway = isHome ? '<span class="tm-ha home">Д</span>' : '<span class="tm-ha away">Г</span>';

      // Match label
      const matchType = { group:'Тур '+m.round, qual:'Стыковые', qf:'Четвертьфинал', sf:'Полуфинал', final:'Финал' };
      const typeLabel = matchType[m.match_type] || m.match_type;

      // Goals scored by team in this match (non-TP)
      const matchGoals = m.is_technical ? [] : goals.filter(g =>
        g.match_id === m.id &&
        ((g.team_id === currentTeamId && !g.is_own_goal) ||
         (g.team_id !== currentTeamId && g.is_own_goal))
      ).sort((a,b) => (a.minute||0) - (b.minute||0));

      const scorers = matchGoals.map(g => {
        const p = players.find(x => x.id === g.player_id);
        const name = p ? shortName(p.name) : '?';
        const min  = g.minute ? `${g.minute}'` : '';
        const og   = g.is_own_goal ? ' <span style="color:var(--red);font-size:.68rem">АГ</span>' : '';
        return `<span class="tm-match-scorer">${esc(name)}${og}${min ? ` <span style="opacity:.5">${min}</span>` : ''}</span>`;
      }).join('');

      return `<div class="tm-match-row">
        <div class="tm-match-left">
          <span class="${resBadgeCls}">${resultLabel}</span>
          ${homeAway}
        </div>
        <div class="tm-match-center">
          <div class="tm-match-opp">${oppLogo}<span class="tm-opp-name">${esc(oppTeam.name || '?')}</span></div>
          <div class="tm-match-score-line">
            <span class="tm-score">${myG} : ${oppG}</span>
            <span class="tm-match-type">${esc(typeLabel)}</span>
          </div>
          ${scorers ? `<div class="tm-match-scorers">${scorers}</div>` : ''}
        </div>
      </div>`;
    }).join('');

    el.innerHTML = rows;
  }

  function renderRoster() {
    const roster = players.filter(p => p.team_id === currentTeamId)
      .sort((a,b) => (a.number||999) - (b.number||999) || (a.name||'').localeCompare(b.name||''));

    // Per-player: goals, assists, and list of non-TP matches they scored in
    const goalMap   = {};
    const assistMap = {};
    const goalEvents= {}; // playerId -> [{match_id, minute, is_own_goal, assist_name}]

    goals.forEach(g => {
      // Skip own-goal for scorer stats
      if (g.player_id && !g.is_own_goal) {
        const m = matches.find(x => x.id === g.match_id);
        if (m && !m.is_technical) {
          goalMap[g.player_id] = (goalMap[g.player_id] || 0) + 1;
          if (!goalEvents[g.player_id]) goalEvents[g.player_id] = [];
          const ap = g.assist_player_id ? players.find(x => x.id === g.assist_player_id) : null;
          goalEvents[g.player_id].push({
            match_id:    m.id,
            match_type:  m.match_type,
            round:       m.round,
            home_id:     m.home_id,
            away_id:     m.away_id,
            home_goals:  m.home_goals,
            away_goals:  m.away_goals,
            minute:      g.minute,
            assist_name: ap ? ap.name : null,
          });
        }
      }
      if (g.assist_player_id) {
        const m = matches.find(x => x.id === g.match_id);
        if (m && !m.is_technical) {
          assistMap[g.assist_player_id] = (assistMap[g.assist_player_id] || 0) + 1;
        }
      }
    });

    const el = document.getElementById('tmTabRoster');
    if (!roster.length) {
      el.innerHTML = `<div class="no-players-msg">
        👥 Состав пока не добавлен${isAdmin ? '<br><small>Нажмите «+ Игрок», чтобы добавить</small>' : ''}
      </div>`;
      return;
    }

    el.innerHTML = roster.map(p => {
      const g    = goalMap[p.id]   || 0;
      const a    = assistMap[p.id] || 0;
      const gCls = g ? '' : ' zero';
      const isExpanded = expandedPlayerId === p.id;

      const assistBadge = a > 0
        ? `<span class="player-stat-badge assist" title="Ассистов">👟 ${a}</span>`
        : '';

      // Detail section
      let detailHTML = '';
      if (isExpanded) {
        const evts = goalEvents[p.id] || [];
        // Group by match
        const matchGroups = {};
        evts.forEach(e => {
          const key = e.match_id;
          if (!matchGroups[key]) matchGroups[key] = { ...e, minutes: [] };
          matchGroups[key].minutes.push({ minute: e.minute, assist: e.assist_name });
        });
        const matchTypes = { group:'Тур', qual:'Стыковые', qf:'ЧФ', sf:'ПФ', final:'Финал' };
        const matchRows = Object.values(matchGroups).map(mg => {
          const isHome  = mg.home_id === currentTeamId;
          const oppId   = isHome ? mg.away_id : mg.home_id;
          const oppTeam = teams.find(x => x.id === oppId) || {};
          const myG     = isHome ? mg.home_goals : mg.away_goals;
          const oppG    = isHome ? mg.away_goals : mg.home_goals;
          const won     = myG > oppG, drew = myG === oppG;
          const resCls  = won ? 'pr-res win' : drew ? 'pr-res draw' : 'pr-res loss';
          const resTxt  = won ? 'В' : drew ? 'Н' : 'П';
          const typeTag = mg.match_type === 'group'
            ? `${matchTypes.group} ${mg.round}`
            : (matchTypes[mg.match_type] || mg.match_type);
          const goalsThisMatch = mg.minutes.map(gm => {
            const min  = gm.minute ? `<span class="pr-min">${gm.minute}'</span>` : '';
            const ass  = gm.assist ? `<span class="pr-assist">(${esc(shortName(gm.assist))})</span>` : '';
            return `<span class="pr-goal-event">⚽${min}${ass}</span>`;
          }).join('');
          const haLbl = isHome
            ? '<span class="tm-ha home" style="font-size:.63rem;padding:1px 4px">Д</span>'
            : '<span class="tm-ha away" style="font-size:.63rem;padding:1px 4px">Г</span>';
          return `<div class="pr-match-row">
            <span class="${resCls}">${resTxt}</span>
            ${haLbl}
            <span class="pr-opp">${esc(oppTeam.name || '?')}</span>
            <span class="pr-score">${myG}:${oppG}</span>
            <span class="pr-type">${esc(typeTag)}</span>
            <div class="pr-goals">${goalsThisMatch}</div>
          </div>`;
        });

        const noGoals = !evts.length
          ? '<div style="opacity:.4;font-size:.8rem;padding:8px 0">Голов ещё нет</div>'
          : '';

        const totalMatches = new Set(evts.map(e => e.match_id)).size;
        detailHTML = `<div class="player-detail-box">
          <div class="pd-summary">
            <span class="pd-stat">⚽ ${g} гол${g===1?'':g<5&&g>1?'а':'ов'}</span>
            <span class="pd-sep">·</span>
            <span class="pd-stat">👟 ${a} ассист${a===1?'':a<5&&a>1?'а':'ов'}</span>
            <span class="pd-sep">·</span>
            <span class="pd-stat">🏟 ${totalMatches} матч${totalMatches===1?'':totalMatches<5&&totalMatches>1?'а':'ей'} с голами</span>
          </div>
          ${noGoals}
          ${matchRows.join('')}
        </div>`;
      }

      const hasStats = g > 0 || a > 0;
      const chevron  = hasStats ? `<span class="player-chevron ${isExpanded?'open':''}">${isExpanded?'▲':'▼'}</span>` : '';
      const clickHandler = hasStats ? `onclick="NML.togglePlayer(${p.id})"` : '';
      const clickCursor  = hasStats ? 'style="cursor:pointer"' : '';

      return `<div class="player-item-wrap" data-player-id="${p.id}">
        <div class="player-item ${isExpanded?'expanded':''}" ${clickHandler} ${clickCursor}>
          <span class="player-num">${p.number ? '#' + p.number : '—'}</span>
          <span class="player-name">${esc(p.name)}</span>
          <span class="player-stat-badge goal${gCls}">⚽ ${g}</span>
          ${assistBadge}
          ${chevron}
          <button class="btn-rename-player" onclick="event.stopPropagation();NML.renamePlayer(${p.id})" title="Переименовать">✏</button>
          <button class="btn-remove-player" onclick="event.stopPropagation();NML.removePlayer(${p.id})" title="Удалить игрока">✕</button>
        </div>
        ${detailHTML}
      </div>`;
    }).join('');
  }

  function togglePlayerExpand(playerId) {
    expandedPlayerId = expandedPlayerId === playerId ? null : playerId;
    renderRoster();
  }

  function initTeamModal() {
    const overlay = document.getElementById('teamModal');
    overlay.addEventListener('click', e => { if (e.target === overlay) closeTeamModal(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !overlay.hidden) closeTeamModal();
      if (e.key === 'Escape' && !document.getElementById('teamPage').hidden) closeTeamPage();
    });
    document.getElementById('tmLogoInput').addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      await uploadLogoForTeam(currentTeamId, file);
      e.target.value = '';
    });
  }

  /* =========================================================
     TEAM PAGE (separate full-screen view)
     ========================================================= */
  function openTeamPage(teamId) {
    teamPageId  = teamId;
    teamPageTab = 'roster';
    renderTeamPage();
    document.getElementById('teamPage').hidden = false;
    window.scrollTo(0, 0);
  }

  function closeTeamPage() {
    document.getElementById('teamPage').hidden = true;
    teamPageId = null;
  }

  function switchTeamPageTab(tab) {
    teamPageTab = tab;
    document.querySelectorAll('.tp-tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    document.getElementById('tpRosterTab').style.display  = tab === 'roster'  ? '' : 'none';
    document.getElementById('tpMatchesTab').style.display = tab === 'matches' ? '' : 'none';
    if (tab === 'matches') renderTeamPageMatches();
  }

  function renderTeamPage() {
    const t = teams.find(x => x.id === teamPageId);
    if (!t) return;

    // Logo
    const img = document.getElementById('tpLogoImg');
    const ph  = document.getElementById('tpLogoPlaceholder');
    if (t.logo) { img.src = t.logo; img.hidden = false; ph.hidden = true; }
    else        { img.hidden = true; ph.hidden = false; }

    // Admin logo upload button
    const adminLogoBtn = document.getElementById('tpAdminLogoBtn');
    adminLogoBtn.innerHTML = isAdmin
      ? `<label class="logo-upload-btn" style="display:inline-block;cursor:pointer">
           📷 Лого
           <input type="file" accept="image/*" hidden onchange="NML.tpLogoChange(event)">
         </label>`
      : '';

    // Name & meta
    document.getElementById('tpTeamName').textContent = t.name;
    const st        = getStandings().find(r => r.id === teamPageId) || {};
    const teamGoals = goals.filter(g => g.team_id === teamPageId && !g.is_own_goal).length;
    const pCount    = players.filter(p => p.team_id === teamPageId).length;
    const mPlayed   = matches.filter(m =>
      m.played && (m.home_id === teamPageId || m.away_id === teamPageId)
    ).length;
    document.getElementById('tpTeamMeta').innerHTML =
      `<span>📋 ${pCount} игрок${pCount===1?'':pCount<5?'а':'ов'}</span>` +
      `<span>🏟 ${mPlayed} матч${mPlayed===1?'':mPlayed<5&&mPlayed>1?'а':'ей'}</span>` +
      (st.pts != null ? `<span>🏆 ${st.pts} очков</span>` : '') +
      `<span>⚽ ${teamGoals} гол${teamGoals===1?'':teamGoals<5&&teamGoals>1?'а':'ов'}</span>`;

    // + Player button (admin only)
    const addBtn = document.getElementById('tpAddPlayerBtn');
    if (addBtn) addBtn.style.display = isAdmin ? '' : 'none';

    renderTeamPagePlayerCards();
    renderTeamPageRoster();

    // Reset to roster tab
    document.querySelectorAll('.tp-tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === 'roster');
    });
    document.getElementById('tpRosterTab').style.display  = '';
    document.getElementById('tpMatchesTab').style.display = 'none';
  }

  function renderTeamPagePlayerCards() {
    const el = document.getElementById('tpPlayerCardsInner');
    if (!el) return;
    const roster = players.filter(p => p.team_id === teamPageId)
      .sort((a,b) => (a.number||999) - (b.number||999) || (a.name||'').localeCompare(b.name||''));

    const goalMap = {};
    goals.forEach(g => {
      if (g.player_id && !g.is_own_goal) {
        const m = matches.find(x => x.id === g.match_id);
        if (m && !m.is_technical) goalMap[g.player_id] = (goalMap[g.player_id] || 0) + 1;
      }
    });

    if (!roster.length) {
      el.innerHTML = '<div class="no-players-msg">Состав пока не добавлен</div>';
      return;
    }

    el.innerHTML = roster.map(p => {
      const g = goalMap[p.id] || 0;
      const initials = (p.name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
      const photoEl = p.photo
        ? `<img src="${esc(p.photo)}" class="tp-player-card-photo" alt="${esc(p.name)}">`
        : `<div class="tp-player-card-ph">${initials}</div>`;
      const goalsBadge = g > 0 ? `<div class="tp-player-card-goals">⚽ ${g}</div>` : '';
      const adminClick = isAdmin ? `onclick="NML.promptPlayerPhoto(${p.id})"` : '';
      return `<div class="tp-player-card" ${adminClick} title="${esc(p.name)}">
        ${photoEl}
        <div class="tp-player-card-info">
          <div class="tp-player-card-num">${p.number ? '#' + p.number : ''}</div>
          <div class="tp-player-card-name">${esc(p.name)}</div>
          ${goalsBadge}
        </div>
      </div>`;
    }).join('');
  }

  function renderTeamPageRoster() {
    const roster = players.filter(p => p.team_id === teamPageId)
      .sort((a,b) => (a.number||999) - (b.number||999) || (a.name||'').localeCompare(b.name||''));
    const goalMap   = {};
    const assistMap = {};
    goals.forEach(g => {
      if (g.player_id && !g.is_own_goal) {
        const m = matches.find(x => x.id === g.match_id);
        if (m && !m.is_technical) goalMap[g.player_id] = (goalMap[g.player_id] || 0) + 1;
      }
      if (g.assist_player_id) {
        const m = matches.find(x => x.id === g.match_id);
        if (m && !m.is_technical) assistMap[g.assist_player_id] = (assistMap[g.assist_player_id] || 0) + 1;
      }
    });

    const el = document.getElementById('tpRosterTab');
    if (!el) return;
    if (!roster.length) {
      el.innerHTML = `<div class="no-players-msg">👥 Состав пока не добавлен${isAdmin?'<br><small>Нажмите «+ Игрок»</small>':''}</div>`;
      return;
    }
    el.innerHTML = roster.map(p => {
      const g = goalMap[p.id] || 0;
      const a = assistMap[p.id] || 0;
      const gCls = g ? '' : ' zero';
      const assistBadge = a > 0 ? `<span class="player-stat-badge assist" title="Ассистов">👟 ${a}</span>` : '';
      return `<div class="player-item-wrap" data-player-id="${p.id}">
        <div class="player-item">
          <span class="player-num">${p.number ? '#' + p.number : '—'}</span>
          <span class="player-name">${esc(p.name)}</span>
          <span class="player-stat-badge goal${gCls}">⚽ ${g}</span>
          ${assistBadge}
          ${isAdmin ? `<button class="btn-rename-player" onclick="NML.renamePlayer(${p.id})" title="Переименовать">✏</button>` : ''}
          ${isAdmin ? `<button class="btn-remove-player" onclick="NML.removePlayerPage(${p.id})" title="Удалить">✕</button>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  function renderTeamPageMatches() {
    const el = document.getElementById('tpMatchesTab');
    if (!el) return;
    const teamMatches = matches.filter(m =>
      m.played && (m.home_id === teamPageId || m.away_id === teamPageId)
    ).sort((a,b) => {
      const order = { group:0, qual:1, qf:2, sf:3, final:4 };
      const oa = order[a.match_type] ?? 0, ob = order[b.match_type] ?? 0;
      if (oa !== ob) return oa - ob;
      return (a.round||0) - (b.round||0);
    });
    if (!teamMatches.length) {
      el.innerHTML = '<div class="no-players-msg">Сыгранных матчей пока нет</div>'; return;
    }
    const matchType = { group:'Тур ', qual:'Стыковые', qf:'Четвертьфинал', sf:'Полуфинал', final:'Финал' };
    el.innerHTML = teamMatches.map(m => {
      const isHome = m.home_id === teamPageId;
      const oppId  = isHome ? m.away_id : m.home_id;
      const myG    = isHome ? m.home_goals : m.away_goals;
      const oppG   = isHome ? m.away_goals : m.home_goals;
      const won    = myG > oppG, drew = myG === oppG;
      const resultLabel = m.is_technical ? 'ТП' : (won ? 'В' : drew ? 'Н' : 'П');
      const resBadgeCls = m.is_technical ? 'tm-res tp' : (won ? 'tm-res win' : drew ? 'tm-res draw' : 'tm-res loss');
      const oppTeam = teams.find(x => x.id === oppId) || {};
      const oppLogo = oppTeam.logo
        ? `<img src="${esc(oppTeam.logo)}" class="team-logo-sm" alt="">`
        : `<span class="team-logo-placeholder-sm"></span>`;
      const homeAway = isHome ? '<span class="tm-ha home">Д</span>' : '<span class="tm-ha away">Г</span>';
      const typeLabel = m.match_type === 'group'
        ? 'Тур ' + m.round
        : (matchType[m.match_type] || m.match_type);
      const matchGoals = m.is_technical ? [] : goals.filter(g =>
        g.match_id === m.id &&
        ((g.team_id === teamPageId && !g.is_own_goal) || (g.team_id !== teamPageId && g.is_own_goal))
      ).sort((a,b) => (a.minute||0) - (b.minute||0));
      const scorers = matchGoals.map(g => {
        const p = players.find(x => x.id === g.player_id);
        const name = p ? shortName(p.name) : '?';
        const min  = g.minute ? `${g.minute}'` : '';
        const og   = g.is_own_goal ? ' <span style="color:var(--red);font-size:.68rem">АГ</span>' : '';
        return `<span class="tm-match-scorer">${esc(name)}${og}${min ? ` <span style="opacity:.5">${min}</span>` : ''}</span>`;
      }).join('');
      return `<div class="tm-match-row">
        <div class="tm-match-left">
          <span class="${resBadgeCls}">${resultLabel}</span>
          ${homeAway}
        </div>
        <div class="tm-match-center">
          <div class="tm-match-opp">${oppLogo}<span class="tm-opp-name">${esc(oppTeam.name || '?')}</span></div>
          <div class="tm-match-score-line">
            <span class="tm-score">${myG} : ${oppG}</span>
            <span class="tm-match-type">${esc(typeLabel)}</span>
          </div>
          ${scorers ? `<div class="tm-match-scorers">${scorers}</div>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  function toggleAddPlayerPage() {
    const form = document.getElementById('tpAddPlayerForm');
    form.style.display = form.style.display === 'flex' ? 'none' : 'flex';
    if (form.style.display === 'flex') document.getElementById('tpApName').focus();
  }

  async function addPlayerPage() {
    const num      = parseInt(document.getElementById('tpApNum').value) || null;
    const fullName = document.getElementById('tpApName').value.trim();
    if (!fullName) { toast('Введите имя игрока'); return; }
    const { error } = await db.from('players').insert([{
      team_id:    teamPageId,
      name:       fullName,
      number:     num,
      sort_order: players.filter(p => p.team_id === teamPageId).length,
    }]);
    if (error) { toast('Ошибка добавления игрока'); console.error(error); return; }
    document.getElementById('tpApNum').value  = '';
    document.getElementById('tpApName').value = '';
    document.getElementById('tpAddPlayerForm').style.display = 'none';
    await loadAll();
    renderTeamPage();
    toast('Игрок добавлен');
  }

  async function removePlayerPage(playerId) {
    if (!confirm('Удалить игрока? Голы также будут удалены.')) return;
    await db.from('goals').delete().eq('player_id', playerId);
    const { error } = await db.from('players').delete().eq('id', playerId);
    if (error) { toast('Ошибка удаления'); console.error(error); return; }
    await loadAll();
    if (teamPageId) renderTeamPage();
    toast('Игрок удалён');
  }

  function promptPlayerPhoto(playerId) {
    if (!isAdmin) return;
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = async e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async ev => {
        const { error } = await db.from('players').update({ photo: ev.target.result }).eq('id', playerId);
        if (error) { toast('Ошибка загрузки фото'); console.error(error); return; }
        await loadAll();
        if (teamPageId) renderTeamPage();
        toast('Фото сохранено');
      };
      reader.readAsDataURL(file);
    };
    inp.click();
  }

  async function tpLogoChange(event) {
    const file = event.target.files[0];
    if (!file || !teamPageId) return;
    await uploadLogoForTeam(teamPageId, file);
    event.target.value = '';
  }

  /* ── Add player: Фамилия + Имя + Номер (no rating) ── */
  async function addPlayer() {
    const num      = parseInt(document.getElementById('apNum').value) || null;
    const fullName = document.getElementById('apName').value.trim();

    if (!fullName) { toast('Введите имя игрока'); return; }

    const { error } = await db.from('players').insert([{
      team_id:    currentTeamId,
      name:       fullName,
      number:     num,
      sort_order: players.filter(p => p.team_id === currentTeamId).length,
    }]);
    if (error) { toast('Ошибка добавления игрока'); console.error(error); return; }

    document.getElementById('apNum').value  = '';
    document.getElementById('apName').value = '';
    await loadAll();
    renderTeamModal();
    toast('Игрок добавлен');
  }

  function renamePlayer(playerId) {
    const wrap = document.querySelector(`.player-item-wrap[data-player-id="${playerId}"]`);
    if (!wrap) return;
    const nameEl = wrap.querySelector('.player-name');
    if (!nameEl) return;

    const origName = nameEl.textContent;
    const inp = document.createElement('input');
    inp.className = 'player-name-input';
    inp.value     = origName;
    inp.maxLength = 80;

    let done = false;
    const save = async () => {
      if (done) return; done = true;
      const newName = inp.value.trim();
      if (!newName || newName === origName) { restore(); return; }
      const { error } = await db.from('players').update({ name: newName }).eq('id', playerId);
      if (error) { toast('Ошибка сохранения'); restore(); return; }
      await loadAll();
      if (currentTeamId) renderTeamModal();
      if (teamPageId)    renderTeamPage();
      toast('Имя обновлено');
    };
    const restore = () => { nameEl.style.display = ''; inp.remove(); };

    nameEl.style.display = 'none';
    nameEl.after(inp);
    inp.focus(); inp.select();
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.preventDefault(); done = true; restore(); }
    });
    inp.addEventListener('blur', save);
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
    if (form.classList.contains('visible')) document.getElementById('apName').focus();
  }

  /* =========================================================
     LOGO UPLOAD
     ========================================================= */
  async function uploadLogoForTeam(teamId, file) {
    const reader = new FileReader();
    reader.onload = async e => {
      const { error } = await db.from('teams').update({ logo: e.target.result }).eq('id', teamId);
      if (error) { toast('Ошибка загрузки логотипа'); console.error(error); return; }
      await loadAll();
      if (currentTeamId === teamId) renderTeamModal();
      if (teamPageId === teamId) renderTeamPage();
      toast('Логотип сохранён');
    };
    reader.readAsDataURL(file);
  }

  function promptLogoUpload(teamId) {
    if (!isAdmin) return;
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = async e => { if (e.target.files[0]) await uploadLogoForTeam(teamId, e.target.files[0]); };
    inp.click();
  }

  /* =========================================================
     MATCH MODAL
     ========================================================= */

  /* ── Open: admin gets edit mode, non-admin gets view mode ── */
  function openModal(matchId) {
    const m = matches.find(x => x.id === matchId);
    if (!m) return;
    if (!m.played && !isAdmin) return; // guests see only played matches

    modalMatchId = matchId;
    goalSide     = 'home';

    // Load existing goals into working copy
    modalGoals = goals.filter(g => g.match_id === matchId).map(g => {
      const p  = players.find(x => x.id === g.player_id);
      const ap = g.assist_player_id ? players.find(x => x.id === g.assist_player_id) : null;
      return {
        player_id:        g.player_id,
        team_id:          g.team_id,
        player_name:      p  ? p.name  : '?',
        minute:           g.minute || null,
        assist_player_id: g.assist_player_id || null,
        assist_name:      ap ? ap.name : null,
        is_own_goal:      g.is_own_goal || false,
      };
    });

    const inner = document.getElementById('modalInner');
    inner.innerHTML = isAdmin ? buildAdminModalHTML(m) : buildViewModalHTML(m);
    document.getElementById('modal').hidden = false;

    if (isAdmin) {
      // Attach score change listeners for mismatch warning
      ['adminHomeGoals', 'adminAwayGoals'].forEach(id => {
        document.getElementById(id).addEventListener('input', updateGoalChips);
        document.getElementById(id).addEventListener('keydown', e => {
          if (e.key === 'Enter') saveModal();
        });
      });
      initGoalSideTabs(m);
      updateGoalChips();
    }
  }

  /* ── Build HTML for admin edit modal ── */
  function buildAdminModalHTML(m) {
    const isKO  = m.match_type !== 'group';
    const title = isKO ? 'Результат (плей-офф — ничья невозможна)' : 'Результат матча';
    const hg    = m.played ? m.home_goals : 0;
    const ag    = m.played ? m.away_goals : 0;
    const isTp  = m.is_technical || false;
    const dateVal = m.match_date || '';
    const clearBtn = m.played
      ? `<button onclick="NML.clearModal()" class="btn-secondary">Очистить</button>` : '';

    const hasPlayers = players.some(p => p.team_id === m.home_id || p.team_id === m.away_id);
    // goalSection shown only when not technical
    const goalSection = hasPlayers ? buildGoalEntrySection(m) : '';

    const tpChecked = isTp ? 'checked' : '';
    // Which team got TP: the one with 0 goals (or home by default on new entry)
    const tpLoserDefault = (isTp && m.home_goals === 0) ? m.home_id : (isTp ? m.away_id : m.home_id);
    const tpOptions = [
      `<option value="${m.home_id}" ${tpLoserDefault === m.home_id ? 'selected' : ''}>${esc(tName(m.home_id))}</option>`,
      `<option value="${m.away_id}" ${tpLoserDefault === m.away_id ? 'selected' : ''}>${esc(tName(m.away_id))}</option>`,
    ].join('');

    return `
      <h3 style="text-align:center;margin-bottom:18px;font-size:1.1rem">${esc(title)}</h3>

      <!-- Technical defeat toggle -->
      <div class="tp-toggle-row" id="tpToggleRow">
        <label class="tp-toggle-label">
          <input type="checkbox" id="tpCheck" ${tpChecked} onchange="NML.onTpChange()">
          <span class="tp-toggle-text">⚠️ Техническое поражение</span>
        </label>
      </div>
      <!-- TP loser selector (shown when TP checked) -->
      <div id="tpLoserRow" class="tp-loser-row" style="display:${isTp ? 'flex' : 'none'}">
        <span class="tp-loser-label">Проигравшая команда:</span>
        <select id="tpLoser" class="ge-select" style="min-width:160px">${tpOptions}</select>
      </div>

      <div class="modal-match" id="scoreRow">
        <div class="modal-team">
          <span id="adminHomeName">${esc(tName(m.home_id))}</span>
          <input type="number" id="adminHomeGoals" min="0" value="${hg}" ${isTp ? 'disabled' : ''}>
        </div>
        <span class="modal-vs">:</span>
        <div class="modal-team">
          <input type="number" id="adminAwayGoals" min="0" value="${ag}" ${isTp ? 'disabled' : ''}>
          <span id="adminAwayName">${esc(tName(m.away_id))}</span>
        </div>
      </div>
      <div id="goalEntryWrap">${goalSection}</div>
      <div class="match-date-row">
        <label class="match-date-label">📅 Дата матча</label>
        <input type="date" id="adminMatchDate" class="match-date-input" value="${dateVal}">
      </div>
      <div class="modal-actions" style="margin-top:16px">
        <button onclick="NML.saveModal()" class="btn-accent">Сохранить</button>
        ${clearBtn}
        <button onclick="NML.closeModal()" class="btn-ghost">Отмена</button>
      </div>`;
  }

  /* ── Technical defeat toggle handler ── */
  function onTpChange() {
    const m   = matches.find(x => x.id === modalMatchId);
    if (!m) return;
    const isTp = document.getElementById('tpCheck').checked;
    const loserRow  = document.getElementById('tpLoserRow');
    const hGoal     = document.getElementById('adminHomeGoals');
    const aGoal     = document.getElementById('adminAwayGoals');
    const goalWrap  = document.getElementById('goalEntryWrap');

    loserRow.style.display = isTp ? 'flex' : 'none';

    if (isTp) {
      // Auto-set score 3:0, disable inputs, hide goal entry
      const loserId = parseInt(document.getElementById('tpLoser').value);
      if (loserId === m.home_id) { hGoal.value = 0; aGoal.value = 3; }
      else                       { hGoal.value = 3; aGoal.value = 0; }
      hGoal.disabled = true;
      aGoal.disabled = true;
      if (goalWrap) goalWrap.style.display = 'none';
    } else {
      hGoal.disabled = false;
      aGoal.disabled = false;
      if (goalWrap) goalWrap.style.display = '';
      updateGoalChips();
    }
  }

  /* Called when TP loser dropdown changes (so score stays correct) */
  function onTpLoserChange() {
    const m   = matches.find(x => x.id === modalMatchId);
    if (!m) return;
    const loserId = parseInt(document.getElementById('tpLoser').value);
    const hGoal   = document.getElementById('adminHomeGoals');
    const aGoal   = document.getElementById('adminAwayGoals');
    if (loserId === m.home_id) { hGoal.value = 0; aGoal.value = 3; }
    else                       { hGoal.value = 3; aGoal.value = 0; }
  }

  /* ── Build HTML for goal entry (admin) ── */
  function buildGoalEntrySection(m) {
    const homeName = shortTeamLabel(tName(m.home_id));
    const awayName = shortTeamLabel(tName(m.away_id));

    // Populate scorer options will happen via updateGoalPlayerDropdowns()
    return `
      <div class="goal-entry-section">
        <div class="ge-header">⚽ ГОЛЫ</div>
        <div class="ge-form-row">
          <input id="geMinute" type="number" class="ge-minute" placeholder="Мин" min="1" max="120">
          <div class="ge-side-tabs">
            <button id="geHomeTab" class="ge-side-tab active" onclick="NML.setGoalSide('home')">${esc(homeName)}</button>
            <button id="geAwayTab" class="ge-side-tab"        onclick="NML.setGoalSide('away')">${esc(awayName)}</button>
          </div>
          <select id="geScorer" class="ge-select"><option value="">Игрок...</option></select>
          <select id="geAssist" class="ge-select"><option value="">Ассист (опц.)</option></select>
          <label class="ge-og-label"><input type="checkbox" id="geOG" onchange="NML.onOGChange()"> АГ</label>
          <button class="btn-sm-accent" onclick="NML.addGoalEvent()">+ Гол</button>
        </div>
        <div id="goalsChips" class="goals-chips"></div>
        <div id="gsMismatchWarn" class="gs-mismatch-warn" hidden></div>
      </div>`;
  }

  /* ── Init goal side tabs & populate dropdowns after HTML is injected ── */
  function initGoalSideTabs(m) {
    goalSide = 'home';
    updateGoalPlayerDropdowns(m);
    // Wire up TP loser dropdown if present
    const tpLoserSel = document.getElementById('tpLoser');
    if (tpLoserSel) tpLoserSel.addEventListener('change', NML_onTpLoserChange);
    // Hide goal section if technical
    if (m.is_technical) {
      const goalWrap = document.getElementById('goalEntryWrap');
      if (goalWrap) goalWrap.style.display = 'none';
    }
  }

  /* ── Set goal side (home/away) ── */
  function setGoalSide(side) {
    goalSide = side;
    const m  = matches.find(x => x.id === modalMatchId);
    if (!m) return;
    document.getElementById('geHomeTab').classList.toggle('active', side === 'home');
    document.getElementById('geAwayTab').classList.toggle('active', side === 'away');
    updateGoalPlayerDropdowns(m);
  }

  /* ── Update scorer & assist dropdowns ── */
  function updateGoalPlayerDropdowns(m) {
    if (!m) m = matches.find(x => x.id === modalMatchId);
    if (!m) return;

    const teamId    = goalSide === 'home' ? m.home_id : m.away_id;
    const teamPlayers = players.filter(p => p.team_id === teamId)
      .sort((a,b) => (a.number||999) - (b.number||999));

    const scorerSel = document.getElementById('geScorer');
    const assistSel = document.getElementById('geAssist');
    if (!scorerSel || !assistSel) return;

    const makeOpt = p =>
      `<option value="${p.id}">${p.number ? '#'+p.number+' ' : ''}${esc(p.name)}</option>`;

    scorerSel.innerHTML = '<option value="">Игрок...</option>' +
      teamPlayers.map(makeOpt).join('');

    assistSel.innerHTML = '<option value="">Ассист (опц.)</option>' +
      teamPlayers.map(makeOpt).join('');

    // Remove selected scorer from assist options dynamically
    scorerSel.onchange = () => {
      const scorerId = parseInt(scorerSel.value) || 0;
      Array.from(assistSel.options).forEach(opt => {
        opt.disabled = opt.value && parseInt(opt.value) === scorerId;
      });
    };
  }

  /* ── Own goal change: if OG, disable assist ── */
  function onOGChange() {
    const isOG     = document.getElementById('geOG').checked;
    const assistSel = document.getElementById('geAssist');
    if (!assistSel) return;
    if (isOG) { assistSel.value = ''; assistSel.disabled = true; }
    else       { assistSel.disabled = false; }
  }

  /* ── Add goal event (admin) ── */
  function addGoalEvent() {
    const m = matches.find(x => x.id === modalMatchId);
    if (!m) return;

    const minute   = parseInt(document.getElementById('geMinute').value) || null;
    const scorerId = parseInt(document.getElementById('geScorer').value) || null;
    const assistId = parseInt(document.getElementById('geAssist').value) || null;
    const isOG     = document.getElementById('geOG').checked;

    if (!scorerId) { toast('Выберите игрока, который забил'); return; }

    const scorer   = players.find(p => p.id === scorerId);
    const assist   = assistId ? players.find(p => p.id === assistId) : null;
    const teamId   = goalSide === 'home' ? m.home_id : m.away_id;

    modalGoals.push({
      player_id:        scorerId,
      team_id:          teamId,
      player_name:      scorer  ? scorer.name  : '?',
      minute,
      assist_player_id: assistId || null,
      assist_name:      assist  ? assist.name  : null,
      is_own_goal:      isOG,
    });

    // Reset minute input; keep side & scorer for quick multi-goal entry
    document.getElementById('geMinute').value = '';
    document.getElementById('geOG').checked   = false;
    if (document.getElementById('geAssist')) {
      document.getElementById('geAssist').disabled = false;
      document.getElementById('geAssist').value    = '';
    }

    updateGoalChips();
  }

  /* ── Remove goal from working list ── */
  function removeGoalFromModal(idx) {
    modalGoals.splice(idx, 1);
    updateGoalChips();
  }

  /* ── Render goal chips + mismatch warning ── */
  function updateGoalChips() {
    const m = matches.find(x => x.id === modalMatchId);
    if (!m) return;
    const chipsEl = document.getElementById('goalsChips');
    if (!chipsEl) return;

    if (!modalGoals.length) {
      chipsEl.innerHTML = '<span class="goals-empty-hint">Нажмите «+ Гол» чтобы записать авторов голов</span>';
    } else {
      // Sort by minute
      const sorted = [...modalGoals].map((g,i) => ({...g, _idx: i}))
        .sort((a,b) => (a.minute||0) - (b.minute||0));

      chipsEl.innerHTML = sorted.map(g => {
        const isHome = g.team_id === m.home_id;
        const color  = isHome ? '#d4a017' : '#74b9ff';
        const minTxt = g.minute ? `<span class="goal-chip-min">${g.minute}'</span>` : '';
        const ogTag  = g.is_own_goal ? '<span class="goal-chip-og">АГ</span>' : '';
        const asTxt  = (!g.is_own_goal && g.assist_name)
          ? `<span class="goal-chip-assist">(${esc(shortName(g.assist_name))})</span>` : '';
        return `<span class="goal-chip">
          <span class="goal-chip-dot" style="background:${color}"></span>
          ${minTxt}
          <span class="goal-chip-name">${esc(shortName(g.player_name))}</span>
          ${ogTag}${asTxt}
          <button class="goal-chip-remove" onclick="NML.removeGoal(${g._idx})">×</button>
        </span>`;
      }).join('');
    }

    // Mismatch warning
    const warn = document.getElementById('gsMismatchWarn');
    if (!warn) return;

    const hScore = parseInt((document.getElementById('adminHomeGoals') || {}).value) || 0;
    const aScore = parseInt((document.getElementById('adminAwayGoals') || {}).value) || 0;

    // Own goals count for the opponent
    const hGoals = modalGoals.filter(g =>
      (g.team_id === m.home_id && !g.is_own_goal) ||
      (g.team_id === m.away_id && g.is_own_goal)
    ).length;
    const aGoals = modalGoals.filter(g =>
      (g.team_id === m.away_id && !g.is_own_goal) ||
      (g.team_id === m.home_id && g.is_own_goal)
    ).length;

    if (modalGoals.length && (hGoals !== hScore || aGoals !== aScore)) {
      warn.hidden      = false;
      warn.textContent = `⚠ Записано: ${hGoals}+${aGoals}=${hGoals+aGoals}, а счёт ${hScore}:${aScore}`;
    } else {
      warn.hidden = true;
    }
  }

  /* ── Build HTML for non-admin readonly view ── */
  function buildViewModalHTML(m) {
    const matchGoals = goals.filter(g => g.match_id === m.id)
      .sort((a,b) => (a.minute||0) - (b.minute||0));

    // Technical defeat banner
    const tpBanner = m.is_technical
      ? `<div class="view-tp-banner">⚠️ Техническое поражение</div>`
      : '';

    const goalsHTML = matchGoals.length && !m.is_technical
      ? matchGoals.map(g => {
          const p   = players.find(x => x.id === g.player_id);
          const ap  = g.assist_player_id ? players.find(x => x.id === g.assist_player_id) : null;
          const isHome = (g.team_id === m.home_id && !g.is_own_goal) ||
                         (g.team_id === m.away_id &&  g.is_own_goal);
          const color  = isHome ? '#d4a017' : '#74b9ff';
          const align  = isHome ? '' : ' away-goal';
          const name   = p ? shortName(p.name) : '?';
          const minTxt = g.minute ? `<span class="vg-min">${g.minute}'</span>` : '<span class="vg-min"></span>';
          const ogTag  = g.is_own_goal
            ? '<span class="vg-og-tag">АГ</span>' : '';
          const assistTxt = (!g.is_own_goal && ap)
            ? `<span class="vg-assist">(${esc(shortName(ap.name))})</span>` : '';
          return `<div class="view-goal-row${align}">
            <span class="vg-dot" style="background:${color}"></span>
            ${minTxt}
            <span class="vg-name">${esc(name)} ${ogTag}</span>
            ${assistTxt}
          </div>`;
        }).join('')
      : (m.is_technical ? '' : '<div class="view-no-goals">Авторы голов не указаны</div>');

    return `
      <div class="view-match-header">
        <div class="view-match-score">${m.home_goals} : ${m.away_goals}</div>
        <div class="view-match-teams">
          <span>${esc(tName(m.home_id))}</span>
          <span>${esc(tName(m.away_id))}</span>
        </div>
      </div>
      ${tpBanner}
      <div class="view-goals-list">${goalsHTML}</div>
      <div class="view-close-row">
        <button onclick="NML.closeModal()" class="btn-accent">Закрыть</button>
      </div>`;
  }

  /* ── Save match (admin) ── */
  async function saveModal() {
    if (modalMatchId === null) return;
    const m  = matches.find(x => x.id === modalMatchId);
    if (!m) return;

    const tpCheckEl = document.getElementById('tpCheck');
    const isTp      = tpCheckEl ? tpCheckEl.checked : false;

    let hg, ag;
    if (isTp) {
      const loserId = parseInt((document.getElementById('tpLoser') || {}).value);
      hg = loserId === m.home_id ? 0 : 3;
      ag = loserId === m.home_id ? 3 : 0;
    } else {
      hg = Math.max(0, parseInt((document.getElementById('adminHomeGoals') || {}).value) || 0);
      ag = Math.max(0, parseInt((document.getElementById('adminAwayGoals') || {}).value) || 0);
      if (m.match_type !== 'group' && hg === ag) {
        toast('В плей-офф ничья невозможна!');
        return;
      }
    }

    const dateEl = document.getElementById('adminMatchDate');
    const matchDate = dateEl && dateEl.value ? dateEl.value : null;

    const { error } = await db.from('matches')
      .update({ home_goals: hg, away_goals: ag, played: true, is_technical: isTp, match_date: matchDate })
      .eq('id', modalMatchId);
    if (error) { toast('Ошибка сохранения'); console.error(error); return; }

    // No goal events for technical defeats
    await db.from('goals').delete().eq('match_id', modalMatchId);
    if (!isTp && modalGoals.length) {
      const rows = modalGoals.map(g => ({
        match_id:         modalMatchId,
        player_id:        g.player_id,
        team_id:          g.team_id,
        minute:           g.minute   || null,
        assist_player_id: g.assist_player_id || null,
        is_own_goal:      g.is_own_goal || false,
      }));
      const { error: ge } = await db.from('goals').insert(rows);
      if (ge) console.error('Goal insert error', ge);
    }

    closeModal();
    await loadAll();
    toast(isTp ? 'Техническое поражение сохранено' : 'Результат сохранён');
    syncToSheets();
  }

  /* ── Clear match result (admin) ── */
  async function clearModal() {
    if (modalMatchId === null) return;
    const m = matches.find(x => x.id === modalMatchId);
    if (!m) return;
    await db.from('matches')
      .update({ home_goals: null, away_goals: null, played: false, is_technical: false })
      .eq('id', modalMatchId);
    await db.from('goals').delete().eq('match_id', modalMatchId);
    const downstream = { qual:['qf','sf','final'], qf:['sf','final'], sf:['final'] };
    const stages = downstream[m.match_type];
    if (stages && stages.length) await db.from('matches').delete().in('match_type', stages);
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

  /* Close on overlay click or Escape */
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('modal').addEventListener('click', e => {
      if (e.target.id === 'modal') closeModal();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !document.getElementById('modal').hidden) closeModal();
    });
  });

  /* =========================================================
     SUPABASE ACTIONS
     ========================================================= */
  async function renameTeam(id, name) {
    const clean = name.trim() || 'Команда';
    await db.from('teams').update({ name: clean }).eq('id', id);
    await loadAll();
  }

  async function addManualMatch() {
    const home_id = +document.getElementById('manualHome').value;
    const away_id = +document.getElementById('manualAway').value;
    const hg = parseInt(document.getElementById('manualHomeGoals').value);
    const ag = parseInt(document.getElementById('manualAwayGoals').value);
    if (home_id === away_id) { toast('Команды должны быть разными'); return; }
    const played = Number.isInteger(hg) && Number.isInteger(ag);
    await db.from('matches').insert([{
      match_type:'group', slot:null, round:null,
      home_id, away_id,
      home_goals: played ? hg : null,
      away_goals: played ? ag : null,
      played,
    }]);
    await loadAll();
    toast('Матч добавлен');
  }

  /* ── Schedule generation ── */
  function seededRng(seed) {
    let s = seed | 0;
    return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  }

  function computeSchedule(seed) {
    const rand = seededRng(seed);
    const ids  = teams.map(t => t.id);
    const n    = ids.length;
    if (n < 2) return [];
    const fixed = ids[0], rot = ids.slice(1);
    const allRounds = [];
    for (let r = 0; r < n - 1; r++) {
      const pairs = [[fixed, rot[0]]];
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
          match_type:'group', slot:null, round:tour+1,
          home_id: swap?b:a, away_id: swap?a:b,
          home_goals:null, away_goals:null, played:false,
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
    await db.from('settings').upsert({ key:'seed', value:String(seedVal) });
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

  /* ── Create knockout stages ── */
  async function createQual() {
    const st = getStandings();
    if (st.length < 10) return;
    await db.from('matches').insert([
      { match_type:'qual', slot:'q1', round:null, home_id:st[6].id, away_id:st[9].id, played:false },
      { match_type:'qual', slot:'q2', round:null, home_id:st[7].id, away_id:st[8].id, played:false },
    ]);
    await loadAll(); toast('Стыковые матчи созданы');
  }

  async function createQF() {
    const st = getStandings();
    const q1w = winner(slotMatch('q1')), q2w = winner(slotMatch('q2'));
    if (!q1w || !q2w) { toast('Сначала завершите стыковые матчи'); return; }
    await db.from('matches').insert([
      { match_type:'qf', slot:'qf1', round:null, home_id:st[0].id, away_id:q2w,      played:false },
      { match_type:'qf', slot:'qf2', round:null, home_id:st[3].id, away_id:st[4].id,  played:false },
      { match_type:'qf', slot:'qf3', round:null, home_id:st[1].id, away_id:q1w,       played:false },
      { match_type:'qf', slot:'qf4', round:null, home_id:st[2].id, away_id:st[5].id,  played:false },
    ]);
    await loadAll(); toast('Четвертьфиналы созданы');
  }

  async function createSF() {
    const qf1w = winner(slotMatch('qf1')), qf2w = winner(slotMatch('qf2'));
    const qf3w = winner(slotMatch('qf3')), qf4w = winner(slotMatch('qf4'));
    if (!qf1w || !qf2w || !qf3w || !qf4w) { toast('Сначала завершите все четвертьфиналы'); return; }
    await db.from('matches').insert([
      { match_type:'sf', slot:'sf1', round:null, home_id:qf1w, away_id:qf2w, played:false },
      { match_type:'sf', slot:'sf2', round:null, home_id:qf3w, away_id:qf4w, played:false },
    ]);
    await loadAll(); toast('Полуфиналы созданы');
  }

  async function createFinal() {
    const sf1w = winner(slotMatch('sf1')), sf2w = winner(slotMatch('sf2'));
    if (!sf1w || !sf2w) { toast('Сначала завершите полуфиналы'); return; }
    await db.from('matches').insert([
      { match_type:'final', slot:'final', round:null, home_id:sf1w, away_id:sf2w, played:false },
    ]);
    await loadAll(); toast('Финал создан!');
  }

  /* =========================================================
     IMPORT / EXPORT
     ========================================================= */
  function exportMatches() {
    const data = matches.map(m => ({
      match_type:m.match_type, slot:m.slot, round:m.round,
      home:tName(m.home_id), away:tName(m.away_id),
      home_goals:m.home_goals, away_goals:m.away_goals, played:m.played,
    }));
    downloadJSON(data, 'nml-matches.json'); toast('Матчи скачаны');
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
    if (!confirm(`Импорт ${data.length} матчей. Текущие матчи будут заменены. Продолжить?`)) return;
    await db.from('matches').delete().gt('id', 0);
    const rows = data.map(m => ({
      match_type:m.match_type||'group', slot:m.slot||null, round:m.round||null,
      home_id:nameMap[m.home.toLowerCase()], away_id:nameMap[m.away.toLowerCase()],
      home_goals: m.played!==false&&m.home_goals!=null ? m.home_goals : null,
      away_goals: m.played!==false&&m.away_goals!=null ? m.away_goals : null,
      played:     m.played!==false&&m.home_goals!=null&&m.away_goals!=null,
    }));
    await db.from('matches').insert(rows);
    await loadAll(); toast('Импортировано ' + rows.length + ' матчей');
  }

  function exportTable() {
    const st = customTable || getStandings();
    const data = st.map((r,i) => ({
      pos:i+1, name:r.name, p:r.p, w:r.w, d:r.d, l:r.l,
      gs:r.gs, gc:r.gc, gd:r.gd!=null?r.gd:r.gs-r.gc, pts:r.pts,
    }));
    downloadJSON(data, 'nml-table.json'); toast('Таблица скачана');
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
      return { name:realName||r.name, p:r.p, w:r.w, d:r.d, l:r.l, gs:r.gs, gc:r.gc, gd:r.gd!=null?r.gd:r.gs-r.gc, pts:r.pts };
    });
    if (missing.length) { toast('Не найдены команды: ' + missing.join(', ')); customTable=null; return; }
    customTable.sort((a,b) => b.pts-a.pts||b.gd-a.gd||b.gs-a.gs||a.name.localeCompare(b.name));
    await db.from('settings').upsert({ key:'custom_table', value:JSON.stringify(customTable) });
    render(); toast('Таблица загружена');
  }

  async function clearCustomTable() {
    customTable = null;
    await db.from('settings').delete().eq('key','custom_table');
    render(); toast('Загруженная таблица сброшена');
  }

  function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename; a.click();
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
        if (codeInp.value === ADMIN_CODE) login();
        else { toast('Неверный код'); codeInp.value = ''; }
      }
      if (e.key === 'Escape') codeBox.hidden = true;
    });
  }

  function login() {
    isAdmin = true;
    sessionStorage.setItem('nml_admin', '1');
    document.getElementById('codeBox').hidden = true;
    document.getElementById('adminCode').value = '';
    applyAdminMode();
    render();
    toast('Админ-режим активирован');
    document.querySelector('.nav-btn[data-tab="admin"]').click();
  }

  function logout() {
    isAdmin = false;
    sessionStorage.removeItem('nml_admin');
    applyAdminMode();
    render();
    document.querySelector('.nav-btn[data-tab="table"]').click();
    toast('Вы вышли из админ-режима');
  }

  function applyAdminMode() {
    document.body.classList.toggle('admin-mode', isAdmin);
    document.querySelector('.nav-btn[data-tab="admin"]').style.display = isAdmin ? '' : 'none';
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
     GOOGLE SHEETS SYNC
     ========================================================= */
  async function syncToSheets() {
    try {
      const standings = getStandings();
      const played = matches.filter(m => m.played).map(m => ({
        type:m.match_type, round:m.round,
        home:tName(m.home_id), homeGoals:m.home_goals,
        awayGoals:m.away_goals, away:tName(m.away_id),
      }));
      const order = { group:0, qual:1, qf:2, sf:3, final:4 };
      played.sort((a,b) => (order[a.type]||0)-(order[b.type]||0)||(a.round||0)-(b.round||0));
      const res = await fetch('/api/sheets', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ standings, matches:played }),
      });
      if (!res.ok) console.warn('Sheets sync failed:', await res.text());
    } catch (e) { console.warn('Sheets sync error:', e); }
  }

  /* =========================================================
     HELPERS
     ========================================================= */
  function tName(id) {
    if (id === null || id === undefined) return 'TBD';
    const t = teams.find(t => t.id === id);
    return t ? t.name : '???';
  }

  /** "Иванов Александр" → "Иванов А." */
  function shortName(fullName) {
    if (!fullName) return '?';
    const parts = String(fullName).trim().split(/\s+/);
    if (parts.length === 1) return parts[0];
    return parts[0] + ' ' + parts[1][0] + '.';
  }

  /** Shorten team name for tabs (max 10 chars) */
  function shortTeamLabel(name) {
    if (!name) return '?';
    return name.length > 10 ? name.slice(0, 9) + '…' : name;
  }

  function esc(s) {
    if (!s) return '';
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  }

  let toastTimer;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
  }

  /* =========================================================
     PUBLIC API (called from inline HTML onclick)
     ========================================================= */
  // Alias needed by initGoalSideTabs which runs before NML is defined
  function NML_onTpLoserChange() { onTpLoserChange(); }

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
    // Hall of Fame admin
    addToHof:       addToHof,
    removeFromHof:  removeFromHof,
    changeHofPhoto: changeHofPhoto,
    // Team page (separate full-screen view)
    openTeamPage:        openTeamPage,
    closeTeamPage:       closeTeamPage,
    switchTeamPageTab:   switchTeamPageTab,
    toggleAddPlayerPage: toggleAddPlayerPage,
    addPlayerPage:       addPlayerPage,
    removePlayerPage:    removePlayerPage,
    promptPlayerPhoto:   promptPlayerPhoto,
    tpLogoChange:        tpLogoChange,
    // Team modal (kept for internal use)
    openTeam:         openTeamModal,
    closeTeam:        closeTeamModal,
    switchTab:        switchTeamTab,
    togglePlayer:     togglePlayerExpand,
    toggleAddPlayer:  toggleAddPlayerForm,
    addPlayer:        addPlayer,
    renamePlayer:     renamePlayer,
    removePlayer:     removePlayer,
    promptLogoUpload: promptLogoUpload,
    // Match modal
    saveModal:        saveModal,
    clearModal:       clearModal,
    closeModal:       closeModal,
    setGoalSide:      setGoalSide,
    addGoalEvent:     addGoalEvent,
    removeGoal:       removeGoalFromModal,
    onOGChange:       onOGChange,
    onTpChange:       onTpChange,
    onTpLoserChange:  onTpLoserChange,
    // Players tab filter
    filterPlayers:    (v) => { playerFilter = v || ''; renderPlayersTab(); },
    setSort:          (s) => setPlayerSort(s),
    searchPlayers:    (q) => { playerSearch = (q||'').trim(); renderPlayersTab(); },
    toggleMatchFilter: (type, checked) => {
    if (type === 'played') matchFilterPlayed = checked;
    if (type === 'unplayed') matchFilterUnplayed = checked;
    renderMatches();
  },
  };

})();
