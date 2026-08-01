CREATE TABLE schema_version (version INTEGER NOT NULL);
INSERT INTO schema_version(version) VALUES (23);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  display_name TEXT,
  model TEXT,
  system_prompt TEXT,
  parent_session_id TEXT,
  started_at REAL NOT NULL,
  ended_at REAL,
  message_count INTEGER DEFAULT 0,
  tool_call_count INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  reasoning_tokens INTEGER DEFAULT 0,
  cwd TEXT,
  estimated_cost_usd REAL,
  actual_cost_usd REAL,
  title TEXT,
  api_call_count INTEGER DEFAULT 0
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  tool_call_id TEXT,
  tool_calls TEXT,
  tool_name TEXT,
  effect_disposition TEXT,
  timestamp REAL NOT NULL,
  reasoning TEXT,
  reasoning_content TEXT,
  reasoning_details TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  compacted INTEGER NOT NULL DEFAULT 0,
  display_kind TEXT,
  display_metadata TEXT
);

INSERT INTO sessions(
  id, source, display_name, model, system_prompt, parent_session_id,
  started_at, ended_at, message_count, tool_call_count,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  reasoning_tokens, cwd, actual_cost_usd, title, api_call_count
) VALUES (
  'synthetic-hermes-parent', 'cli', 'Synthetic parent', 'synthetic-model-db',
  'Synthetic parent prompt.', NULL, 1785542390, 1785542391, 0, 0,
  0, 0, 0, 0, 0, '/synthetic/project', NULL, 'Synthetic parent', 0
);

INSERT INTO sessions(
  id, source, display_name, model, system_prompt, parent_session_id,
  started_at, ended_at, message_count, tool_call_count,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  reasoning_tokens, cwd, estimated_cost_usd, actual_cost_usd, title, api_call_count
) VALUES (
  'synthetic-hermes-db', 'cli', 'Synthetic Hermes DB', 'synthetic-model-db',
  'Synthetic DB system preamble.', 'synthetic-hermes-parent',
  1785542400, 1785542405, 4, 1,
  100, 30, 20, 5, 10, '/synthetic/project', 0.99, 0.0123, 'Synthetic Hermes DB', 1
);

INSERT INTO messages(session_id, role, content, timestamp, active, compacted)
VALUES ('synthetic-hermes-db', 'user', 'Locate hermes-db-search-needle.', 1785542401, 1, 0);

INSERT INTO messages(session_id, role, content, tool_calls, timestamp, reasoning_content, active, compacted)
VALUES (
  'synthetic-hermes-db', 'assistant', 'I will inspect the synthetic file.',
  '[{"id":"call-db-1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"/synthetic/project/README.md\"}"}}]',
  1785542402, 'Reason only over fixture data.', 1, 0
);

INSERT INTO messages(session_id, role, content, tool_call_id, tool_name, timestamp, active, compacted)
VALUES ('synthetic-hermes-db', 'tool', 'hermes-db-tool-result', 'call-db-1', 'read_file', 1785542403, 1, 0);

INSERT INTO messages(session_id, role, content, timestamp, active, compacted)
VALUES ('synthetic-hermes-db', 'assistant', 'Archived synthetic context.', 1785542400.5, 0, 1);
