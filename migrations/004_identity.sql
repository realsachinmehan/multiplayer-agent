-- The repository a session works on. Cloned into the session's workspace
-- with the credentials of whoever first needs it.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS repo_url text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS default_branch text NOT NULL DEFAULT 'main';

-- Each person's own GitHub identity. Side effects the agent takes for
-- someone go out under that person's credentials, never another
-- participant's. The token is encrypted at rest (AES-256-GCM) and never
-- leaves the server: no API returns it and no event records it.
CREATE TABLE IF NOT EXISTS credentials (
  user_id      text PRIMARY KEY,
  git_name     text NOT NULL,
  git_email    text NOT NULL,
  token_enc    bytea NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
