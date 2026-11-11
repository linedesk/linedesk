-- The outside-business-hours instructions are gone (Knowledge shows one text at any hour). A non-empty one is
-- kept: it is appended to the main instructions as a paragraph "Outside business hours: …", then cleared.
-- The column stays for one release (the previous API and agent still read it) and is dropped later.
UPDATE "assistants"
SET
  "business_profile" = jsonb_set(
    "business_profile",
    '{instructions}',
    to_jsonb(
      CASE
        WHEN btrim(coalesce("business_profile"->>'instructions', '')) = ''
          THEN 'Outside business hours: ' || btrim("instructions_outside")
        ELSE btrim("business_profile"->>'instructions') || E'\n\nOutside business hours: ' || btrim("instructions_outside")
      END
    )
  ),
  "instructions_outside" = NULL
WHERE btrim(coalesce("instructions_outside", '')) <> '';
