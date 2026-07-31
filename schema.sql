-- SOMBRA · регистър на твърдения
-- Вече е приложена върху базата sombra (5d2b95a0-a8c5-4419-9e23-6a677c89981c).
-- Пази се за възстановяване:
--   wrangler d1 execute sombra --file=./schema.sql --remote

CREATE TABLE IF NOT EXISTS claims (
  id              TEXT PRIMARY KEY,
  text            TEXT NOT NULL,
  domain          TEXT,
  created_at      TEXT NOT NULL,
  resolution      TEXT,          -- true | false | undetermined | NULL (неразрешено)
  resolved_at     TEXT,
  resolution_note TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  claim_id     TEXT NOT NULL,
  status       TEXT NOT NULL,     -- queued | running | done | error
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  low          INTEGER,           -- обединен интервал след двата паса
  high         INTEGER,
  pro_low      INTEGER, pro_high  INTEGER,
  con_low      INTEGER, con_high  INTEGER,
  falsifier    TEXT,
  note         TEXT,
  error        TEXT
);

CREATE TABLE IF NOT EXISTS atoms (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id  TEXT NOT NULL,
  side    TEXT NOT NULL,          -- pro | contra
  claim   TEXT NOT NULL,
  status  TEXT NOT NULL,          -- supported | disputed | unverifiable
  note    TEXT
);

CREATE TABLE IF NOT EXISTS sources (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  atom_id      INTEGER NOT NULL,
  ref          TEXT,
  url          TEXT,
  kind         TEXT,              -- първичен | вторичен
  resolvable   INTEGER NOT NULL DEFAULT 0,
  independent  INTEGER,           -- 1 = самостоятелно свидетелство, 0 = производен
  derives_from TEXT
);

CREATE TABLE IF NOT EXISTS silence (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id   TEXT NOT NULL,
  expected TEXT,
  cause    TEXT,                  -- унищожено | неизследвано | никога не е съществувало | неизвестно
  prior    REAL                   -- оценен дял оцеляване 0..1
);

CREATE INDEX IF NOT EXISTS idx_runs_claim   ON runs(claim_id);
CREATE INDEX IF NOT EXISTS idx_atoms_run    ON atoms(run_id);
CREATE INDEX IF NOT EXISTS idx_sources_atom ON sources(atom_id);
CREATE INDEX IF NOT EXISTS idx_silence_run  ON silence(run_id);
