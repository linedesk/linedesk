ALTER TABLE "contacts" ADD COLUMN "name_source" text;--> statement-breakpoint
-- Who gave the names already there is not recorded. A caller can only have named a contact on a call of
-- that contact (call.finish, appointment.book), and calls are never removed: a named contact without any
-- call was named by the team (by hand, an import, a seed). Every other name counts as a caller's until a
-- member confirms it, so it unlocks nothing on the phone. The previous release ignores the column.
UPDATE "contacts" SET "name_source" = CASE
  WHEN EXISTS (SELECT 1 FROM "calls" WHERE "calls"."contact_id" = "contacts"."id") THEN 'caller'
  ELSE 'member'
END
WHERE "name" IS NOT NULL;
