CREATE TABLE "shopify_installs" (
	"id" text PRIMARY KEY NOT NULL,
	"shop" text NOT NULL,
	"shop_name" text,
	"workspace_id" text,
	"access_token_encrypted" text,
	"refresh_token_encrypted" text,
	"expires_at" timestamp with time zone,
	"scope" text,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"exchanged_at" timestamp with time zone,
	"uninstalled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shopify_installs_shop_unique" UNIQUE("shop")
);
--> statement-breakpoint
CREATE TABLE "shopify_link_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"shop" text NOT NULL,
	"started_by" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shopify_installs" ADD CONSTRAINT "shopify_installs_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_link_tokens" ADD CONSTRAINT "shopify_link_tokens_shop_shopify_installs_shop_fk" FOREIGN KEY ("shop") REFERENCES "public"."shopify_installs"("shop") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shopify_installs_ws" ON "shopify_installs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "shopify_link_tokens_shop" ON "shopify_link_tokens" USING btree ("shop");