-- Hack4Hack PS1 — data model. Source of truth for the schema.
--
-- Idempotent: safe to run repeatedly (psql < schema.sql) and applied
-- automatically on server boot. The one seeded row is the hackathon itself,
-- inserted with ON CONFLICT DO NOTHING so re-runs never duplicate it.
--
-- Design notes (see docs/design-doc.md for the full reasoning):
--   * team_members carries hackathon_id redundantly so the one-team-per-person
--     rule is a single unique index — the database, not app code, is the
--     final arbiter.
--   * audit_log.team_id is ON DELETE SET NULL: deleting a team (last member
--     leaves) must not fail on its own history, and the audit row for the
--     deletion itself carries the team id in its details JSON instead.
--   * hackathons.name is unique so the seed insert below is conflict-safe.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext UNIQUE NOT NULL,
  password_hash text NOT NULL,
  name text NOT NULL,
  skills text[] NOT NULL DEFAULT '{}',
  timezone text NOT NULL DEFAULT 'UTC',
  looking_for_teammates boolean NOT NULL DEFAULT true,
  bio text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hackathons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  starts_at timestamptz,
  ends_at timestamptz,
  team_min_size int NOT NULL DEFAULT 2,
  team_max_size int NOT NULL DEFAULT 4,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id uuid NOT NULL REFERENCES hackathons (id) ON DELETE CASCADE,
  name text NOT NULL,
  leader_id uuid NOT NULL REFERENCES users (id),
  invite_code text UNIQUE NOT NULL,
  invite_expires_at timestamptz NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id),
  hackathon_id uuid NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id),
  UNIQUE (hackathon_id, user_id)
);

CREATE TABLE IF NOT EXISTS join_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined')),
  message text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid REFERENCES teams (id) ON DELETE SET NULL,
  actor_id uuid NOT NULL REFERENCES users (id),
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key text NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  request_hash text NOT NULL,
  response_status int NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, user_id)
);

CREATE INDEX IF NOT EXISTS idx_teams_hackathon ON teams (hackathon_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members (user_id);
CREATE INDEX IF NOT EXISTS idx_join_requests_team_status ON join_requests (team_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_log_team_created ON audit_log (team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_looking ON users (looking_for_teammates);

-- One pending request per person per team. A declined request can be
-- re-sent later (the old row is no longer pending), but a live one cannot
-- be duplicated even under a race.
CREATE UNIQUE INDEX IF NOT EXISTS idx_join_requests_pending_unique
  ON join_requests (team_id, user_id) WHERE status = 'pending';

-- The single seeded hackathon. Dates are intentionally NULL: the challenge
-- brief gives a submission deadline, not event dates, and we do not invent
-- them. Team size rules (2–4) live on this row, not in code.
INSERT INTO hackathons (name, team_min_size, team_max_size)
VALUES ('Hack4Hack 2026', 2, 4)
ON CONFLICT (name) DO NOTHING;
