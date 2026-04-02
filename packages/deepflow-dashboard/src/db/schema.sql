-- deepflow-dashboard SQLite schema
-- All tables use CREATE TABLE IF NOT EXISTS for idempotent migrations.

CREATE TABLE IF NOT EXISTS _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Insert schema version on first run; ignored on subsequent runs.
INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '5');

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  user             TEXT NOT NULL,
  project          TEXT,
  model            TEXT,
  tokens_in        INTEGER NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out       INTEGER NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  cache_read       INTEGER NOT NULL DEFAULT 0 CHECK (cache_read >= 0),
  cache_creation   INTEGER NOT NULL DEFAULT 0 CHECK (cache_creation >= 0),
  cache_creation_5m INTEGER NOT NULL DEFAULT 0 CHECK (cache_creation_5m >= 0),
  cache_creation_1h INTEGER NOT NULL DEFAULT 0 CHECK (cache_creation_1h >= 0),
  duration_ms      INTEGER,
  messages         INTEGER NOT NULL DEFAULT 0,
  tool_calls       INTEGER NOT NULL DEFAULT 0,
  cost             REAL    NOT NULL DEFAULT 0 CHECK (cost >= 0),
  started_at       TEXT    NOT NULL,   -- ISO-8601
  ended_at         TEXT,
  agent_role          TEXT    NOT NULL DEFAULT 'unknown',
  cache_hit_ratio     REAL    DEFAULT NULL,
  parent_session_id   TEXT    DEFAULT NULL REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS token_events (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id             TEXT    NOT NULL REFERENCES sessions(id),
  model                  TEXT    NOT NULL,
  source                 TEXT    NOT NULL DEFAULT 'ingest',
  input_tokens           INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens          INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens      INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_creation_tokens  INTEGER NOT NULL DEFAULT 0 CHECK (cache_creation_tokens >= 0),
  timestamp              TEXT    NOT NULL,  -- ISO-8601
  agent_role             TEXT    NOT NULL DEFAULT 'unknown',
  UNIQUE (session_id, model, source)
);

CREATE TABLE IF NOT EXISTS quota_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user        TEXT    NOT NULL,
  window_type TEXT    NOT NULL,   -- 'hourly' | 'daily' | 'monthly'
  used        INTEGER NOT NULL DEFAULT 0,
  limit_val   INTEGER,
  reset_at    TEXT,               -- ISO-8601
  captured_at TEXT    NOT NULL    -- ISO-8601
);

CREATE TABLE IF NOT EXISTS task_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT    NOT NULL,
  spec        TEXT,
  session_id  TEXT,
  status      TEXT    NOT NULL DEFAULT 'unknown',
  tokens_in   INTEGER DEFAULT 0,
  tokens_out  INTEGER DEFAULT 0,
  cache_read  INTEGER DEFAULT 0,
  cost        REAL    DEFAULT 0,
  started_at  TEXT    NOT NULL,
  ended_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL REFERENCES sessions(id),
  tool_name   TEXT    NOT NULL,
  call_count  INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  timestamp   TEXT    NOT NULL    -- ISO-8601
);

CREATE TABLE IF NOT EXISTS command_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  command    TEXT    NOT NULL,
  timestamp  TEXT    NOT NULL,    -- ISO-8601
  -- Nullable: CLI commands may run outside sessions (global /init, cross-project tools)
  session_id TEXT    REFERENCES sessions(id)
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_sessions_agent_role    ON sessions(agent_role);
-- idx_sessions_parent created in v3→v4 migration (parent_session_id may not exist yet)
CREATE INDEX IF NOT EXISTS idx_sessions_user          ON sessions(user);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at    ON sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_token_events_session   ON token_events(session_id);
CREATE INDEX IF NOT EXISTS idx_token_events_timestamp ON token_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_quota_user_window      ON quota_snapshots(user, window_type);
CREATE INDEX IF NOT EXISTS idx_task_attempts_task_id  ON task_attempts(task_id);
CREATE INDEX IF NOT EXISTS idx_task_attempts_spec     ON task_attempts(spec);
CREATE INDEX IF NOT EXISTS idx_tool_usage_session     ON tool_usage(session_id);
CREATE INDEX IF NOT EXISTS idx_command_history_ts     ON command_history(timestamp);
