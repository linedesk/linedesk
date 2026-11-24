-- LIN-403: the command log keeps only the host of a webhook URL (its path or query can carry the receiver's token).
-- webhook.create and webhook.update are audited, so the 90-day prune never cuts them down: rewrite the rows stored
-- before, once. "https://user:pw@Hooks.Example.com/x?token=1" becomes "hooks.example.com"; anything else "a URL".
UPDATE "commands"
SET "input" = jsonb_set(
  "input",
  '{url}',
  to_jsonb(coalesce(
    lower(substring("input"->>'url' from '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/?#\\]*@)?([^/?#\\@]+)')),
    'a URL'
  ))
)
WHERE "action" IN ('webhook.create', 'webhook.update')
  AND jsonb_typeof("input"->'url') = 'string'
  AND "input"->>'url' !~ '^([a-z0-9.-]+|\[[0-9a-f:.]+\])(:[0-9]+)?$';
