ALTER TABLE operator_endpoints
  ADD COLUMN unsupported_tool_schema_keywords jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(unsupported_tool_schema_keywords) = 'array');
