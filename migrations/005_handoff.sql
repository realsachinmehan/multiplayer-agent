-- Handoff notes are written next to the agent loop, not inside it, so they
-- take their own claim instead of the session lease: a note can be written
-- while the agent keeps working. One claim per request; a worker that dies
-- mid-note lets its claim expire and another worker writes the note.
CREATE TABLE IF NOT EXISTS summary_claims (
  session_id   uuid NOT NULL REFERENCES sessions(id),
  request_seq  bigint NOT NULL,
  worker_id    text NOT NULL,
  expires_at   timestamptz NOT NULL,
  PRIMARY KEY (session_id, request_seq)
);

-- Lets workers find note requests that haven't been answered yet.
CREATE INDEX IF NOT EXISTS events_summaries ON events (session_id, seq)
  WHERE type IN ('summary_requested', 'summary_ready', 'summary_failed');
