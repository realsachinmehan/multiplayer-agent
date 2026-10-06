-- Who is watching a session right now. One row per open connection, so a
-- person with two tabs open counts once but closing one tab keeps them
-- present. Rows expire on their own if a server dies without cleaning up.
-- Presence is deliberately not in the event log: it is live state, not
-- session history.
CREATE TABLE IF NOT EXISTS presence (
  connection_id  uuid PRIMARY KEY,
  session_id     uuid NOT NULL REFERENCES sessions(id),
  user_id        text NOT NULL,
  expires_at     timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS presence_session ON presence (session_id);
