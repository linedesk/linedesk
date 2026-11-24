-- LIN-791: the billing rule `regulatedNumberFeeWaived` (free numbers that need documents, from the German beta) goes in
-- one step before go-live. A row that is no JSON object already reads as the install defaults.
UPDATE "instance_settings" SET "value" = ("value"::jsonb - 'regulatedNumberFeeWaived')::text
  WHERE "key" = 'billing.rules'
    AND CASE WHEN "value" IS JSON OBJECT THEN "value"::jsonb ? 'regulatedNumberFeeWaived' ELSE false END;
