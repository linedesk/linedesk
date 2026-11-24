-- Workspace rights (LIN-246): exactly one owner per workspace. A workspace with several owners keeps the one who
-- joined first (the creator, as a rule); the others become admins, who keep every setting and the team.
UPDATE "member" AS m SET "role" = 'admin'
WHERE m."role" = 'owner'
  AND EXISTS (
    SELECT 1 FROM "member" AS first
    WHERE first."organization_id" = m."organization_id" AND first."role" = 'owner'
      AND (first."created_at", first."id") < (m."created_at", m."id")
  );--> statement-breakpoint
-- An owner invitation to a workspace that has an owner joins as admin instead (only a workspace without an owner can
-- invite one, since this release).
UPDATE "invitation" AS i SET "role" = 'admin'
WHERE i."role" = 'owner' AND i."status" = 'pending'
  AND EXISTS (SELECT 1 FROM "member" AS m WHERE m."organization_id" = i."organization_id" AND m."role" = 'owner');--> statement-breakpoint
CREATE UNIQUE INDEX "member_one_owner_uidx" ON "member" USING btree ("organization_id") WHERE "member"."role" = 'owner';
