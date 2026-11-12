-- Services and prices and FAQs are no longer settings: an assistant that has them gets them in its
-- "About the business" text (instructions), so it keeps knowing them, and the lists are cleared. An empty
-- About text first takes the older structured fields, as the web app showed them.
UPDATE "assistants" AS a
SET "business_profile" = (a."business_profile" - 'service_list' - 'faqs') || jsonb_build_object('instructions', f.text)
FROM (
  SELECT
    "id",
    concat_ws(
      E'\n\n',
      coalesce(
        nullif(btrim("business_profile"->>'instructions'), ''),
        nullif(concat_ws(
          E'\n',
          'About: ' || nullif(btrim("business_profile"->>'description'), ''),
          'Service area: ' || nullif(btrim("business_profile"->>'service_area'), ''),
          'Address: ' || nullif(btrim("business_profile"->>'address'), ''),
          'Hours: ' || nullif(btrim("business_profile"->>'hours'), '')
        ), '')
      ),
      (
        SELECT 'Services and prices:' || E'\n' || string_agg(
          '- ' || btrim(s->>'name') || ': '
            || coalesce(nullif(btrim(s->>'price'), ''), 'quote only, no price on the phone')
            || coalesce(' (' || nullif(btrim(s->>'description'), '') || ')', ''),
          E'\n'
        )
        FROM jsonb_array_elements(coalesce("business_profile"->'service_list', '[]'::jsonb)) AS s
        WHERE btrim(coalesce(s->>'name', '')) <> ''
      ),
      (
        SELECT 'Common questions:' || E'\n' || string_agg('If a caller asks "' || btrim(q->>'q') || '": ' || btrim(q->>'a'), E'\n')
        FROM jsonb_array_elements(coalesce("business_profile"->'faqs', '[]'::jsonb)) AS q
        WHERE btrim(coalesce(q->>'q', '')) <> '' AND btrim(coalesce(q->>'a', '')) <> ''
      )
    ) AS text
  FROM "assistants"
  WHERE (jsonb_typeof("business_profile"->'service_list') = 'array' AND jsonb_array_length("business_profile"->'service_list') > 0)
     OR (jsonb_typeof("business_profile"->'faqs') = 'array' AND jsonb_array_length("business_profile"->'faqs') > 0)
) AS f
WHERE a."id" = f."id";
