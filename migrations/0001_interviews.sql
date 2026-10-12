-- One interview per person (identified by their verified, lower-cased email).
CREATE TABLE interviews (
  email      TEXT PRIMARY KEY CHECK (email <> '' AND email = lower(trim(email))),
  lang       TEXT NOT NULL CHECK (lang IN ('en', 'es')),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- Each interview has exactly two parts: a load becomes available, and a buyer needs a load.
CREATE TABLE interview_parts (
  email        TEXT NOT NULL REFERENCES interviews (email),
  part         TEXT NOT NULL CHECK (part IN ('load', 'buyer')),
  status       TEXT NOT NULL CHECK (status IN ('not_started', 'interviewing', 'finished', 'review', 'confirmed')),
  -- The step-by-step write-up (JSON), present from 'review' onwards.
  summary      TEXT CHECK (summary IS NULL OR json_valid(summary)),
  corrections  TEXT NOT NULL DEFAULT '',
  confirmed_at TEXT,
  version      INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (email, part),
  CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL)),
  CHECK (status NOT IN ('review', 'confirmed') OR summary IS NOT NULL)
) STRICT;

-- The conversation, in order. seq is unique per part, so two concurrent writers cannot both add message n.
CREATE TABLE interview_messages (
  email      TEXT NOT NULL,
  part       TEXT NOT NULL,
  seq        INTEGER NOT NULL CHECK (seq >= 1),
  role       TEXT NOT NULL CHECK (role IN ('interviewer', 'person')),
  content    TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 20000),
  created_at TEXT NOT NULL,
  PRIMARY KEY (email, part, seq),
  FOREIGN KEY (email, part) REFERENCES interview_parts (email, part)
) STRICT;
