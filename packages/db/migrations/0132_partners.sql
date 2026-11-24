CREATE TABLE "partner_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"partner_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_invitations_role" CHECK ("partner_invitations"."role" in ('owner', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "partner_members" (
	"partner_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_members_partner_id_user_id_pk" PRIMARY KEY("partner_id","user_id"),
	CONSTRAINT "partner_members_role" CHECK ("partner_members"."role" in ('owner', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "partners" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"billing_account_id" text,
	"created_by" text NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partners_billing_account_id_unique" UNIQUE("billing_account_id"),
	CONSTRAINT "partners_status" CHECK ("partners"."status" in ('pending', 'approved', 'suspended')),
	CONSTRAINT "partners_suspended" CHECK (("partners"."status" = 'suspended') = ("partners"."suspended_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "member" ADD COLUMN "partner_id" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "partner_id" text;--> statement-breakpoint
ALTER TABLE "partner_invitations" ADD CONSTRAINT "partner_invitations_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_members" ADD CONSTRAINT "partner_members_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_members" ADD CONSTRAINT "partner_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partners" ADD CONSTRAINT "partners_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "partner_invitations_token" ON "partner_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "partner_invitations_partner" ON "partner_invitations" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "partner_invitations_email" ON "partner_invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "partner_members_user" ON "partner_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_members_one_owner" ON "partner_members" USING btree ("partner_id") WHERE "partner_members"."role" = 'owner';--> statement-breakpoint
CREATE INDEX "member_partner_idx" ON "member" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "organization_partner_idx" ON "organization" USING btree ("partner_id");--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_partner_admin" CHECK ("member"."partner_id" is null or "member"."role" = 'admin');--> statement-breakpoint
-- Written by hand: organization and member live in auth-schema.ts, which schema.ts imports, so their foreign keys to
-- partners (schema.ts) cannot be declared there.
alter table "organization" add constraint "organization_partner_id_partners_id_fk"
  foreign key ("partner_id") references "public"."partners"("id") on delete no action on update no action;--> statement-breakpoint
alter table "member" add constraint "member_partner_id_partners_id_fk"
  foreign key ("partner_id") references "public"."partners"("id") on delete no action on update no action;
