-- "If nobody accepts: take a message, mark it urgent" was removed: those contacts take a plain message now.
-- The previous release reads "message" as well, so this keeps it working (expand/contract).
UPDATE "assistants" SET "transfers" = (
  SELECT jsonb_agg(CASE WHEN c->>'if_no_answer' = 'message_urgent' THEN jsonb_set(c, '{if_no_answer}', '"message"') ELSE c END ORDER BY i)
  FROM jsonb_array_elements("transfers") WITH ORDINALITY AS t(c, i)
)
WHERE "transfers" @> '[{"if_no_answer": "message_urgent"}]'::jsonb;
