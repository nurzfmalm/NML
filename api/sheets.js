const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID || '1TKwMEaa26EwHLzCR5wdlX_MeXe12E-xHX_13GsNww7k';

const TYPE_LABELS = {
  group: 'Группа',
  qual:  'Стыковой',
  qf:    'Четвертьфинал',
  sf:    'Полуфинал',
  final: 'Финал',
};

/* ---------- Auth ---------- */
function getAuth() {
  let pk = process.env.GOOGLE_PRIVATE_KEY || '';
  if (pk.includes('\\n')) pk = pk.replace(/\\n/g, '\n');

  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: pk,
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

/* ---------- Ensure sheet tabs exist ---------- */
async function ensureSheets(api) {
  const meta = await api.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: 'sheets.properties.title',
  });
  const existing = meta.data.sheets.map(s => s.properties.title);

  const requests = [];
  if (!existing.includes('Таблица')) requests.push({ addSheet: { properties: { title: 'Таблица' } } });
  if (!existing.includes('Матчи'))   requests.push({ addSheet: { properties: { title: 'Матчи' } } });

  if (requests.length) {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests },
    });
  }
}

/* ---------- Write standings ---------- */
async function writeStandings(api, standings) {
  const header = ['#', 'Команда', 'P', 'W', 'D', 'L', 'GS', 'GC', 'GD', 'Pts'];
  const rows = standings.map((r, i) => [
    i + 1, r.name, r.p, r.w, r.d, r.l, r.gs, r.gc,
    r.gd > 0 ? '+' + r.gd : r.gd,
    r.pts,
  ]);

  await api.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: 'Таблица!A:J',
  });

  await api.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: 'Таблица!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [header, ...rows] },
  });
}

/* ---------- Write match results ---------- */
async function writeMatches(api, matches) {
  const header = ['Стадия', 'Тур', 'Хозяева', 'Голы Х', ':', 'Голы Г', 'Гости'];
  const rows = matches.map(m => [
    TYPE_LABELS[m.type] || m.type,
    m.round || '-',
    m.home,
    m.homeGoals,
    ':',
    m.awayGoals,
    m.away,
  ]);

  await api.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: 'Матчи!A:G',
  });

  await api.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: 'Матчи!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [header, ...rows] },
  });
}

/* ---------- Handler ---------- */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const auth = getAuth();
    const api = google.sheets({ version: 'v4', auth });

    await ensureSheets(api);

    const { standings, matches } = req.body;

    if (standings && standings.length) {
      await writeStandings(api, standings);
    }
    if (matches && matches.length) {
      await writeMatches(api, matches);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Google Sheets error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
