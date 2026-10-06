-- A session is one shared agent run. last_seq is the per-session event
-- counter; bumping it under a row lock is what serializes appends.
CREATE TABLE IF NOT EXISTS sessions (
  id          uuid PRIMARY KEY,
  title       text NOT NULL,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seq    bigint NOT NULL DEFAULT 0,
  -- 'pending': has work the agent hasn't picked up. 'running': a worker holds
  -- (or held, before crashing) the lease. 'idle': nothing to do.
  status      text NOT NULL DEFAULT 'idle'
);

-- Append-only. Nothing in the app issues UPDATE or DELETE on this table.
CREATE TABLE IF NOT EXISTS events (
  session_id    uuid NOT NULL REFERENCES sessions(id),
  seq           bigint NOT NULL,
  type          text NOT NULL,
  -- Who wrote the event: a human user id, or 'agent', or 'system'.
  actor         text NOT NULL,
  -- The human whose instruction this event ultimately serves. For human
  -- events it equals actor; for agent events it is the steerer.
  on_behalf_of  text,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq)
);

-- One worker drives a session at a time. epoch is a fencing token: it goes
-- up every time the lease changes hands, and agent appends must carry the
-- current epoch, so a worker that lost its lease cannot write.
CREATE TABLE IF NOT EXISTS session_leases (
  session_id  uuid PRIMARY KEY REFERENCES sessions(id),
  worker_id   text NOT NULL,
  epoch       bigint NOT NULL,
  expires_at  timestamptz NOT NULL
);
