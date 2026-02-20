-- =============================================
-- NML (NIS Media League) — Supabase Schema
-- Run this in Supabase SQL Editor (supabase.com → project → SQL Editor)
-- =============================================

-- 1) Drop old tables if re-creating
DROP TABLE IF EXISTS matches  CASCADE;
DROP TABLE IF EXISTS teams    CASCADE;
DROP TABLE IF EXISTS settings CASCADE;

-- 2) Teams
CREATE TABLE teams (
  id         SERIAL PRIMARY KEY,
  name       TEXT    NOT NULL DEFAULT '',
  sort_order INT     NOT NULL DEFAULT 0
);

-- 3) Matches (group + knockout)
CREATE TABLE matches (
  id         SERIAL  PRIMARY KEY,
  match_type TEXT    NOT NULL DEFAULT 'group',   -- group | qual | qf | sf | final
  slot       TEXT,                                -- null for group; 'q1','qf1','sf1','final' etc. for knockout
  round      INT,                                 -- tour number (1-8) for group only
  home_id    INT     REFERENCES teams(id) ON DELETE SET NULL,
  away_id    INT     REFERENCES teams(id) ON DELETE SET NULL,
  home_goals  INT,
  away_goals  INT,
  played      BOOLEAN NOT NULL DEFAULT FALSE,
  match_date  DATE
);

-- Unique slot for knockout matches (NULLs are allowed for group rows)
CREATE UNIQUE INDEX matches_slot_idx ON matches (slot) WHERE slot IS NOT NULL;

-- 4) Settings (key-value)
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 5) Row Level Security — public read/write via anon key
ALTER TABLE teams    ENABLE ROW LEVEL SECURITY;
ALTER TABLE matches  ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "teams_public"    ON teams    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "matches_public"  ON matches  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "settings_public" ON settings FOR ALL USING (true) WITH CHECK (true);

-- 6) Seed 16 default teams
INSERT INTO teams (name, sort_order) VALUES
  ('Команда 1',  1),
  ('Команда 2',  2),
  ('Команда 3',  3),
  ('Команда 4',  4),
  ('Команда 5',  5),
  ('Команда 6',  6),
  ('Команда 7',  7),
  ('Команда 8',  8),
  ('Команда 9',  9),
  ('Команда 10', 10),
  ('Команда 11', 11),
  ('Команда 12', 12),
  ('Команда 13', 13),
  ('Команда 14', 14),
  ('Команда 15', 15),
  ('Команда 16', 16);

-- 7) Enable Realtime (optional — for live updates across browsers)
-- Go to Supabase Dashboard → Database → Replication and enable the tables,
-- or run:
ALTER PUBLICATION supabase_realtime ADD TABLE matches;
ALTER PUBLICATION supabase_realtime ADD TABLE teams;
