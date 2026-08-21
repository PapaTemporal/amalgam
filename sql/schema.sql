-- Amalgam memory schema — tencentdb-style L0..L3 layering on PostgreSQL FTS.
-- All content in L1..L3 is stored caveman-dense (compressed at save time).

CREATE SCHEMA IF NOT EXISTS memory;

-- L0: raw conversation log (immutable audit trail; searched only as fallback)
CREATE TABLE IF NOT EXISTS memory.l0_log (
  id          BIGSERIAL PRIMARY KEY,
  session_id  TEXT NOT NULL DEFAULT 'default',
  role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ts          tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);
CREATE INDEX IF NOT EXISTS l0_ts_idx ON memory.l0_log USING GIN (ts);
CREATE INDEX IF NOT EXISTS l0_session_idx ON memory.l0_log (session_id, created_at);

-- L1: distilled atomic facts (the primary recall layer)
CREATE TABLE IF NOT EXISTS memory.l1_facts (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL DEFAULT 'fact'
              CHECK (kind IN ('fact','preference','decision','constraint','instruction')),
  content     TEXT NOT NULL,
  context     TEXT NOT NULL DEFAULT '',   -- project/scene tag, e.g. 'musescore'
  priority    INT  NOT NULL DEFAULT 50,   -- 0..100, higher = surfaces first on ties
  version     INT  NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ts          tsvector GENERATED ALWAYS AS
              (to_tsvector('english', content || ' ' || context)) STORED
);
CREATE INDEX IF NOT EXISTS l1_ts_idx ON memory.l1_facts USING GIN (ts);
CREATE INDEX IF NOT EXISTS l1_context_idx ON memory.l1_facts (context);

-- L2: scenario documents — durable working context per project/topic
CREATE TABLE IF NOT EXISTS memory.l2_scenarios (
  path        TEXT PRIMARY KEY,            -- virtual path, e.g. 'musescore/build-notes'
  content     TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  version     INT  NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ts          tsvector GENERATED ALWAYS AS
              (to_tsvector('english', path || ' ' || summary || ' ' || content)) STORED
);
CREATE INDEX IF NOT EXISTS l2_ts_idx ON memory.l2_scenarios USING GIN (ts);

-- L3: persona — versioned single document (latest row wins)
CREATE TABLE IF NOT EXISTS memory.l3_persona (
  id          BIGSERIAL PRIMARY KEY,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
