-- Apply after state-db.sql to add pinned Hermes lineage variants.

INSERT INTO sessions(
  id, source, display_name, model, model_config, parent_session_id,
  started_at, ended_at, end_reason, title
) VALUES (
  'synthetic-hermes-branch', 'cli', 'Synthetic branch', 'synthetic-model-db',
  '{"_branched_from":"synthetic-hermes-parent"}', 'synthetic-hermes-parent',
  1785542410, 1785542411, 'tui_shutdown', 'Synthetic branch'
);

INSERT INTO sessions(
  id, source, display_name, model, model_config, parent_session_id,
  started_at, ended_at, end_reason, title
) VALUES (
  'synthetic-hermes-delegate', 'cli', 'Synthetic delegate', 'synthetic-model-db',
  '{"_delegate_from":"synthetic-hermes-parent"}', 'synthetic-hermes-parent',
  1785542420, 1785542421, 'completed', 'Synthetic delegate'
);

INSERT INTO sessions(
  id, source, display_name, model, started_at, ended_at, end_reason, title
) VALUES (
  'synthetic-hermes-unclassified-parent', 'cli', 'Synthetic unclassified parent',
  'synthetic-model-db', 1785542430, 1785542431, 'tui_shutdown', 'Synthetic unclassified parent'
);

INSERT INTO sessions(
  id, source, display_name, model, parent_session_id,
  started_at, ended_at, end_reason, title
) VALUES (
  'synthetic-hermes-unclassified', 'cli', 'Synthetic unclassified child',
  'synthetic-model-db', 'synthetic-hermes-unclassified-parent',
  1785542440, 1785542441, 'tui_shutdown', 'Synthetic unclassified child'
);
