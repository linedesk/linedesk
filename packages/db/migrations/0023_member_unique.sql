-- One membership per user and workspace. Any duplicate from an earlier race is merged first:
-- the row with the strongest role (owner, admin, member), then the oldest, stays.
DELETE FROM "member" m USING (
  SELECT id, row_number() OVER (
    PARTITION BY organization_id, user_id
    ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, created_at, id
  ) AS n FROM "member"
) d WHERE m.id = d.id AND d.n > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "member_organization_user_uidx" ON "member" USING btree ("organization_id","user_id");
