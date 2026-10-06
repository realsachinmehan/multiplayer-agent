-- Steering state, projected from the event log in the same transaction
-- that appends the events, so a command can check it under the session's
-- row lock without re-reading the whole log.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS driver text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false;
-- Seq of the latest event that changes what the agent should be doing
-- (pause, resume, handoff, withdrawal). A model turn planned before it is
-- stale and gets discarded.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS control_seq bigint NOT NULL DEFAULT 0;
UPDATE sessions SET driver = created_by WHERE driver IS NULL;
