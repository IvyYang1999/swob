CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  source TEXT,
  started_at REAL
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  role TEXT,
  content TEXT,
  tool_calls TEXT,
  timestamp REAL
);

INSERT INTO sessions VALUES ('old-session', 'cli', 1785542400);
INSERT INTO messages VALUES (1, 'old-session', 'assistant', 'old schema body', '{bad', 1785542401);
