-- LIN-507: as 0146 for webhooks, the command log keeps only the host of a CalDAV server address
-- (calendar.connectWithPassword serverUrl) and of a knowledge import website (knowledge.import url). Rewrite the rows
-- stored before, once. "https://user:pw@CalDAV.Example.com/x?token=1" becomes "caldav.example.com"; anything else "a URL".
UPDATE "commands"
SET "input" = jsonb_set(
  "input",
  '{serverUrl}',
  to_jsonb(coalesce(
    lower(substring("input"->>'serverUrl' from '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/?#\\]*@)?([^/?#\\@]+)')),
    'a URL'
  ))
)
WHERE "action" = 'calendar.connectWithPassword'
  AND jsonb_typeof("input"->'serverUrl') = 'string'
  AND "input"->>'serverUrl' !~* '^([a-z0-9.-]+|\[[0-9a-f:.]+\])(:[0-9]+)?$';
--> statement-breakpoint
UPDATE "commands"
SET "input" = jsonb_set(
  "input",
  '{url}',
  to_jsonb(coalesce(
    lower(substring("input"->>'url' from '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/?#\\]*@)?([^/?#\\@]+)')),
    'a URL'
  ))
)
WHERE "action" = 'knowledge.import'
  AND jsonb_typeof("input"->'url') = 'string'
  AND "input"->>'url' !~* '^([a-z0-9.-]+|\[[0-9a-f:.]+\])(:[0-9]+)?$';
