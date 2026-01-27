-- NCPA Crew Assignment Helper - Database Schema

-- Crew members with capability matrix
CREATE TABLE IF NOT EXISTS crew (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('Senior', 'Mid', 'Junior', 'Hired')),
    can_stage BOOLEAN DEFAULT 1,
    stage_only_if_urgent BOOLEAN DEFAULT 0,
    venue_capabilities TEXT NOT NULL,  -- JSON: {"JBT": "Y*", "Tata": "Y", ...}
    vertical_capabilities TEXT NOT NULL,  -- JSON: {"Indian Music": "Y", "Int'l Music": "Y*", ...}
    special_notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Day-offs (hard blocks)
CREATE TABLE IF NOT EXISTS crew_unavailability (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    crew_id INTEGER NOT NULL,
    unavailable_date TEXT NOT NULL,  -- 'YYYY-MM-DD'
    reason TEXT,
    FOREIGN KEY (crew_id) REFERENCES crew(id) ON DELETE CASCADE,
    UNIQUE(crew_id, unavailable_date)
);

-- Uploaded events
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL,  -- Groups uploads together
    name TEXT NOT NULL,
    event_date TEXT NOT NULL,  -- 'YYYY-MM-DD'
    venue TEXT NOT NULL,
    vertical TEXT NOT NULL,
    stage_crew_needed INTEGER DEFAULT 1,
    event_group TEXT,  -- For multi-day events (hash of name)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Final assignments
CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    crew_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('FOH', 'Stage')),
    was_engine_suggestion BOOLEAN DEFAULT 1,
    was_manually_overridden BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY (crew_id) REFERENCES crew(id) ON DELETE CASCADE
);

-- Monthly workload tracking
CREATE TABLE IF NOT EXISTS workload_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    crew_id INTEGER NOT NULL,
    month TEXT NOT NULL,  -- 'YYYY-MM'
    assignment_count INTEGER DEFAULT 0,
    FOREIGN KEY (crew_id) REFERENCES crew(id) ON DELETE CASCADE,
    UNIQUE(crew_id, month)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_events_batch ON events(batch_id);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);
CREATE INDEX IF NOT EXISTS idx_events_group ON events(event_group);
CREATE INDEX IF NOT EXISTS idx_assignments_event ON assignments(event_id);
CREATE INDEX IF NOT EXISTS idx_assignments_crew ON assignments(crew_id);
CREATE INDEX IF NOT EXISTS idx_unavailability_date ON crew_unavailability(unavailable_date);
CREATE INDEX IF NOT EXISTS idx_unavailability_crew ON crew_unavailability(crew_id);
CREATE INDEX IF NOT EXISTS idx_workload_month ON workload_history(month);
