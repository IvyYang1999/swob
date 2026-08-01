-- Apply after state-db.sql to replace the single-model usage row.

DELETE FROM session_model_usage WHERE session_id = 'synthetic-hermes-db';

INSERT INTO session_model_usage(
  session_id, model, billing_provider, billing_base_url, billing_mode, task,
  api_call_count, input_tokens, output_tokens, cache_read_tokens,
  cache_write_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd,
  cost_status, cost_source, first_seen, last_seen
) VALUES (
  'synthetic-hermes-db', 'synthetic-model-db', 'synthetic-provider', '', '', '',
  1, 80, 25, 15, 5, 8, 0.90, 0.009, 'actual', 'fixture', 1785542401, 1785542404
);

INSERT INTO session_model_usage(
  session_id, model, billing_provider, billing_base_url, billing_mode, task,
  api_call_count, input_tokens, output_tokens, cache_read_tokens,
  cache_write_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd,
  cost_status, cost_source, first_seen, last_seen
) VALUES (
  'synthetic-hermes-db', 'synthetic-vision-model', 'synthetic-vision-provider', '', '', 'vision',
  0, 20, 5, 5, 0, 2, 0.09, 0.0033, 'actual', 'fixture', 1785542402, 1785542402
);
