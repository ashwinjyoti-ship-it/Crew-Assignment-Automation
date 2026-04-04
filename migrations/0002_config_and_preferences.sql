-- NCPA Crew Assignment Helper - Migration 0002
-- Config-driven logic, per-crew monthly caps, persistent FOH preferences

-- 1. System config table for all tunable parameters
CREATE TABLE IF NOT EXISTS system_config (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    description TEXT,
    config_type TEXT CHECK (config_type IN ('number', 'json', 'boolean', 'string')),
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Seed all config defaults (INSERT OR IGNORE = idempotent)
INSERT OR IGNORE INTO system_config (key, value, description, config_type) VALUES
  ('workload_weight_monthly',     '1000',
   'Score penalty per assignment already in current month (primary fairness driver)', 'number'),
  ('workload_weight_seniority',   '100',
   'Seniority bonus multiplier: Senior gets 3x, Mid 2x, Junior 1x this value', 'number'),
  ('workload_weight_historical',  '1',
   '3-month rolling history penalty per past assignment (tiebreaker only)', 'number'),
  ('workload_history_months',     '3',
   'How many prior months to include in the rolling workload window', 'number'),
  ('score_base',                  '10000',
   'Starting score for every candidate before penalties/bonuses are applied', 'number'),
  ('score_stage_nonurgent_bonus', '50',
   'Bonus score for stage candidates that are not marked stage_only_if_urgent', 'number'),
  ('score_oc_penalty',            '5000',
   'Score penalty for outside/hired crew on stage assignments (keeps them as last resort)', 'number'),
  ('score_preferred_foh_penalty', '8000',
   'Score penalty to prevent a preferred-FOH crew member from being grabbed for stage on the same date', 'number'),
  ('venue_defaults',
   '{"JBT":3,"Tata":3,"Experimental":2,"Godrej Dance":1,"Little Theatre":1,"Others":1}',
   'Default total crew count (FOH + stage) per normalized venue name', 'json'),
  ('venue_map',
   '{"JBT":"JBT","Jamshed Bhabha Theatre":"JBT","TT":"Tata","Tata Theatre":"Tata","TATA":"Tata","Tata":"Tata","TET":"Experimental","Tata Experimental Theatre":"Experimental","Experimental Theatre":"Experimental","Experimental":"Experimental","Expl":"Experimental","Expl ZCB":"Experimental","GDT":"Godrej Dance","Godrej Dance Theatre":"Godrej Dance","LT":"Little Theatre","Little Theatre":"Little Theatre","Little":"Little Theatre","Lib":"Others","Library":"Others","DPAG":"Others","Dilip Piramal Art Gallery":"Others","Stuart Liff":"Others","Stuart-Liff":"Others","Stuart Liff Lib":"Others","SVR":"Others","Sea View Room":"Others","Sunken":"Others","Sunken Garden":"Others","OAP":"Others","West Room":"Others","West room 1":"Others","NCPA Reference Library":"Others"}',
   'Venue alias to normalized name mapping (used for CSV parsing)', 'json'),
  ('team_vertical_map',
   '{"Dr.Swapno/Team":"Dance","Dr.Swapno":"Dance","Dr. Swapno/Team":"Dance","Dr.Rao/Team":"Indian Music","Dr. Rao/Team":"Indian Music","Dr. Rao / Team":"Indian Music","Farrahnaz & Team":"Intl Music","Farrahnaz":"Intl Music","Nooshin/Team":"Theatre","Nooshin/ Team":"Theatre","Nooshir/Team":"Theatre","Bruce/Rajeshri":"Theatre","Bruce/Team":"Theatre","Bruce/Binaifar":"Theatre","Bruce/Deepa":"Theatre","Bruce/Ava/Binney":"Theatre","Dr.Sujata/Team":"Library","Dr. Sujata/Team":"Library","Dr.Sujata / Team":"Library","Sujata Jadhav Library NCPA":"Library","Dr.Cavas":"Library","Dr. Cavas":"Library","Bianca/Team":"Western Music","Marketing":"Corporate","DP":"Others","Lit Live":"Others","PAG":"Others","International Music":"Intl Music","Others":"Others","":"Others"}',
   'Team field to vertical mapping (used for CSV parsing)', 'json');

-- 3. Per-crew monthly assignment cap (NULL = no cap)
ALTER TABLE crew ADD COLUMN monthly_assignment_cap INTEGER DEFAULT NULL;

-- Set Naren's cap to match existing hardcoded value (admin duties limit)
UPDATE crew SET monthly_assignment_cap = 9 WHERE name = 'Naren';

-- 4. Persistent FOH preferences table
--    Survives across batches/sessions; merged with session preferences at run time
CREATE TABLE IF NOT EXISTS foh_preferences (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    event_name_contains TEXT NOT NULL,
    crew_id             INTEGER NOT NULL,
    venue_filter        TEXT DEFAULT NULL,      -- NULL = match any venue
    match_mode          TEXT DEFAULT 'contains'
                            CHECK (match_mode IN ('contains', 'exact')),
    is_active           BOOLEAN DEFAULT 1,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (crew_id) REFERENCES crew(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_foh_prefs_active ON foh_preferences(is_active);
CREATE INDEX IF NOT EXISTS idx_foh_prefs_crew   ON foh_preferences(crew_id);
