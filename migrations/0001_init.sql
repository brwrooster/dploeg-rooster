-- D-Ploeg Rooster — initial schema
-- Eén instance = één ploeg. Bij klonen voor andere ploegen: los D1-database + los Worker-project.

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gebruikersnaam TEXT UNIQUE NOT NULL,
  wachtwoord_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS personen (
  id TEXT PRIMARY KEY,
  naam TEXT NOT NULL,
  volgorde INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Welke functies een persoon mag, en met welke prioriteit (vast/reserve)
CREATE TABLE IF NOT EXISTS persoon_functies (
  persoon_id TEXT NOT NULL REFERENCES personen(id) ON DELETE CASCADE,
  functie_code TEXT NOT NULL, -- B, M, CTS, CL, OL
  prioriteit TEXT NOT NULL DEFAULT 'vast', -- 'vast' | 'reserve'
  PRIMARY KEY (persoon_id, functie_code)
);

CREATE TABLE IF NOT EXISTS diensten (
  id TEXT PRIMARY KEY,
  datum TEXT NOT NULL UNIQUE, -- YYYY-MM-DD
  created_at TEXT DEFAULT (datetime('now'))
);

-- Wie is beschikbaar (draait mee) voor een dienst
CREATE TABLE IF NOT EXISTS beschikbaarheid (
  dienst_id TEXT NOT NULL REFERENCES diensten(id) ON DELETE CASCADE,
  persoon_id TEXT NOT NULL REFERENCES personen(id) ON DELETE CASCADE,
  PRIMARY KEY (dienst_id, persoon_id)
);

-- Resultaat van het indelings-algoritme: wie kreeg welke functie voor welke dienst
CREATE TABLE IF NOT EXISTS toewijzingen (
  dienst_id TEXT NOT NULL REFERENCES diensten(id) ON DELETE CASCADE,
  persoon_id TEXT NOT NULL REFERENCES personen(id) ON DELETE CASCADE,
  functie_code TEXT NOT NULL,
  PRIMARY KEY (dienst_id, persoon_id)
);

-- Tekorten per dienst (functiecodes waarvoor niemand bevoegd+beschikbaar was)
CREATE TABLE IF NOT EXISTS tekorten (
  dienst_id TEXT NOT NULL REFERENCES diensten(id) ON DELETE CASCADE,
  functie_code TEXT NOT NULL,
  PRIMARY KEY (dienst_id, functie_code)
);
