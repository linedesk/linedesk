CREATE TABLE "billing_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"status" text DEFAULT 'pending_payment' NOT NULL,
	"interval" text DEFAULT 'month' NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"trial_ends_at" timestamp with time zone,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"auto_recharge" boolean DEFAULT true NOT NULL,
	"recharge_threshold_cents" integer DEFAULT 500 NOT NULL,
	"recharge_amount_cents" integer DEFAULT 2000 NOT NULL,
	"recharge_cap_base_cents" integer DEFAULT 5000 NOT NULL,
	"recharge_failed_at" timestamp with time zone,
	"held_for_review_at" timestamp with time zone,
	"past_due_since" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_accounts_stripe_customer_id_unique" UNIQUE("stripe_customer_id"),
	CONSTRAINT "billing_accounts_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id"),
	CONSTRAINT "billing_accounts_kind" CHECK ("billing_accounts"."kind" in ('cloud', 'partner')),
	CONSTRAINT "billing_accounts_status" CHECK ("billing_accounts"."status" in ('pending_payment', 'trialing', 'active', 'past_due', 'suspended', 'canceled', 'comped')),
	CONSTRAINT "billing_accounts_interval" CHECK ("billing_accounts"."interval" in ('month', 'year')),
	CONSTRAINT "billing_accounts_recharge_cap_base" CHECK ("billing_accounts"."recharge_cap_base_cents" >= 0),
	CONSTRAINT "billing_accounts_recharge_threshold" CHECK ("billing_accounts"."recharge_threshold_cents" between 500 and 10000),
	CONSTRAINT "billing_accounts_recharge_amount" CHECK ("billing_accounts"."recharge_amount_cents" between 2000 and 50000),
	CONSTRAINT "billing_accounts_recharge_over_threshold" CHECK ("billing_accounts"."recharge_amount_cents" >= "billing_accounts"."recharge_threshold_cents" + 500)
);
--> statement-breakpoint
CREATE TABLE "billing_alerts" (
	"billing_account_id" text NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_alerts_billing_account_id_kind_ref_pk" PRIMARY KEY("billing_account_id","kind","ref"),
	CONSTRAINT "billing_alerts_kind" CHECK ("billing_alerts"."kind" in ('recharge_failed', 'recharge_cap_reached', 'low_balance', 'renewal_reminder'))
);
--> statement-breakpoint
CREATE TABLE "billing_balances" (
	"billing_account_id" text PRIMARY KEY NOT NULL,
	"balance_micros" bigint DEFAULT 0 NOT NULL,
	"reserved_micros" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_balances_reserved" CHECK ("billing_balances"."reserved_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "billing_invoices" (
	"stripe_invoice_id" text PRIMARY KEY NOT NULL,
	"billing_account_id" text NOT NULL,
	"kind" text NOT NULL,
	"number" text,
	"status" text NOT NULL,
	"total_cents" integer NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"hosted_invoice_url" text,
	"pdf_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_invoices_kind" CHECK ("billing_invoices"."kind" in ('subscription', 'recharge', 'topup')),
	CONSTRAINT "billing_invoices_status" CHECK ("billing_invoices"."status" in ('draft', 'open', 'paid', 'uncollectible', 'void'))
);
--> statement-breakpoint
CREATE TABLE "billing_periods" (
	"id" text PRIMARY KEY NOT NULL,
	"billing_account_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_periods_start" UNIQUE("billing_account_id","starts_at"),
	CONSTRAINT "billing_periods_kind" CHECK ("billing_periods"."kind" in ('trial', 'month')),
	CONSTRAINT "billing_periods_range" CHECK ("billing_periods"."ends_at" > "billing_periods"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "billing_recharges" (
	"id" text PRIMARY KEY NOT NULL,
	"billing_account_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"stripe_invoice_id" text,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "billing_recharges_stripe_invoice_id_unique" UNIQUE("stripe_invoice_id"),
	CONSTRAINT "billing_recharges_status" CHECK ("billing_recharges"."status" in ('pending', 'paid', 'failed', 'canceled')),
	CONSTRAINT "billing_recharges_amount" CHECK ("billing_recharges"."amount_cents" between 2000 and 50000),
	CONSTRAINT "billing_recharges_resolved" CHECK (("billing_recharges"."status" = 'pending') = ("billing_recharges"."resolved_at" is null))
);
--> statement-breakpoint
CREATE TABLE "call_reservations" (
	"call_id" text PRIMARY KEY NOT NULL,
	"billing_account_id" text NOT NULL,
	"reserved_micros" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_fingerprints" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"first_billing_account_id" text NOT NULL,
	"trial_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"billing_account_id" text NOT NULL,
	"workspace_id" text,
	"period_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"amount_micros" bigint NOT NULL,
	"seconds" integer,
	"included_seconds" integer,
	"billable_seconds" integer,
	"cost_micros" bigint,
	"price_basis" text,
	"rate_card_version" text,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"reverses_entry_id" text,
	"actor_id" text,
	"note" text,
	CONSTRAINT "ledger_entries_source" UNIQUE("source_type","source_id","kind"),
	CONSTRAINT "ledger_entries_bill_entry" UNIQUE("id","billing_account_id"),
	CONSTRAINT "ledger_entries_kind" CHECK ("ledger_entries"."kind" in ('usage', 'number', 'recharge', 'topup', 'refund', 'credit', 'adjustment', 'writeoff')),
	CONSTRAINT "ledger_entries_source_type" CHECK ("ledger_entries"."source_type" in ('call', 'phone_number', 'billing_recharge', 'stripe_checkout', 'stripe_refund', 'admin', 'job')),
	CONSTRAINT "ledger_entries_price_basis" CHECK ("ledger_entries"."price_basis" is null or "ledger_entries"."price_basis" in ('fixed_5c', 'cost_plus_10', 'own_keys')),
	CONSTRAINT "ledger_entries_kind_source" CHECK (("ledger_entries"."kind" = 'usage' and "ledger_entries"."source_type" = 'call') or ("ledger_entries"."kind" = 'number' and "ledger_entries"."source_type" = 'phone_number') or ("ledger_entries"."kind" = 'recharge' and "ledger_entries"."source_type" = 'billing_recharge') or ("ledger_entries"."kind" = 'topup' and "ledger_entries"."source_type" = 'stripe_checkout') or ("ledger_entries"."kind" = 'refund' and "ledger_entries"."source_type" = 'stripe_refund') or ("ledger_entries"."kind" in ('credit', 'adjustment', 'writeoff') and "ledger_entries"."source_type" in ('admin', 'job'))),
	CONSTRAINT "ledger_entries_number_per_period" CHECK ("ledger_entries"."kind" <> 'number' or right("ledger_entries"."source_id", length("ledger_entries"."period_id") + 1) = ':' || "ledger_entries"."period_id"),
	CONSTRAINT "ledger_entries_reverses_adjustment" CHECK ("ledger_entries"."reverses_entry_id" is null or "ledger_entries"."kind" = 'adjustment'),
	CONSTRAINT "ledger_entries_usage_seconds" CHECK ("ledger_entries"."kind" <> 'usage' or ("ledger_entries"."seconds" is not null and "ledger_entries"."included_seconds" is not null and "ledger_entries"."billable_seconds" is not null and "ledger_entries"."included_seconds" >= 0 and "ledger_entries"."billable_seconds" >= 0 and "ledger_entries"."seconds" = "ledger_entries"."included_seconds" + "ledger_entries"."billable_seconds")),
	CONSTRAINT "ledger_entries_seconds_usage_only" CHECK ("ledger_entries"."kind" = 'usage' or ("ledger_entries"."seconds" is null and "ledger_entries"."included_seconds" is null and "ledger_entries"."billable_seconds" is null)),
	CONSTRAINT "ledger_entries_sign" CHECK (("ledger_entries"."kind" in ('usage', 'number', 'refund') and "ledger_entries"."amount_micros" <= 0) or ("ledger_entries"."kind" in ('recharge', 'topup', 'credit', 'writeoff') and "ledger_entries"."amount_micros" >= 0) or "ledger_entries"."kind" = 'adjustment')
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"livemode" boolean NOT NULL,
	"created" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"billing_account_id" text NOT NULL,
	"period_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"included_seconds_used" integer DEFAULT 0 NOT NULL,
	"usage_micros" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_counters_billing_account_id_period_id_workspace_id_pk" PRIMARY KEY("billing_account_id","period_id","workspace_id"),
	CONSTRAINT "usage_counters_included" CHECK ("usage_counters"."included_seconds_used" >= 0)
);
--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "billing_account_id" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "billing_state" text;--> statement-breakpoint
ALTER TABLE "billing_alerts" ADD CONSTRAINT "billing_alerts_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_balances" ADD CONSTRAINT "billing_balances_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_periods" ADD CONSTRAINT "billing_periods_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_recharges" ADD CONSTRAINT "billing_recharges_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_reservations" ADD CONSTRAINT "call_reservations_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_reservations" ADD CONSTRAINT "call_reservations_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_fingerprints" ADD CONSTRAINT "card_fingerprints_first_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("first_billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_period_id_billing_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."billing_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_reverses_same_bill" FOREIGN KEY ("reverses_entry_id","billing_account_id") REFERENCES "public"."ledger_entries"("id","billing_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_period_id_billing_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."billing_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_accounts_owner" ON "billing_accounts" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "billing_invoices_bill" ON "billing_invoices" USING btree ("billing_account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_recharges_one_pending" ON "billing_recharges" USING btree ("billing_account_id") WHERE "billing_recharges"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "billing_recharges_bill_created" ON "billing_recharges" USING btree ("billing_account_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_bill_created" ON "ledger_entries" USING btree ("billing_account_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_workspace_period" ON "ledger_entries" USING btree ("workspace_id","period_id");--> statement-breakpoint
CREATE INDEX "stripe_events_received" ON "stripe_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "organization_billing_account_idx" ON "organization" USING btree ("billing_account_id");--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_billing_state" CHECK ("organization"."billing_state" is null or "organization"."billing_state" in ('pending_payment', 'active', 'suspended'));--> statement-breakpoint
-- The ledger is append-only: no UPDATE, DELETE or TRUNCATE. This guards against bugs, not
-- against tampering: the app connects as the role that owns the tables (POSTGRES_USER, a superuser in the
-- official image), which could disable the trigger, and which a REVOKE would not bind. A separate runtime role
-- with only SELECT and INSERT on the ledger is a later step. The API checks at start that both triggers exist
-- and are enabled with the expected definitions (ledger-guards.ts), and billing refuses to run without them.
create or replace function ledger_entries_append_only() returns trigger as $$
begin
  raise exception 'ledger_entries is append-only: % is not allowed; post an adjustment entry instead', tg_op
    using errcode = 'restrict_violation';
end $$ language plpgsql;
--> statement-breakpoint
create trigger ledger_entries_no_update_delete before update or delete on ledger_entries for each row
  execute function ledger_entries_append_only();
--> statement-breakpoint
create trigger ledger_entries_no_truncate before truncate on ledger_entries for each statement
  execute function ledger_entries_append_only();
--> statement-breakpoint
-- A workspace's bill must exist; a bill with workspaces cannot be deleted. In SQL, since billing_accounts and
-- organization live in different schema files.
alter table "organization" add constraint "organization_billing_account_id_billing_accounts_id_fk"
  foreign key ("billing_account_id") references "public"."billing_accounts"("id") on delete restrict;
--> statement-breakpoint
-- The periods of one bill never overlap, so a call's period and the counters it moves are always one row.
create extension if not exists btree_gist;
--> statement-breakpoint
alter table "billing_periods" add constraint "billing_periods_no_overlap"
  exclude using gist ("billing_account_id" with =, tstzrange("starts_at", "ends_at") with &&);
--> statement-breakpoint
-- billing_balances.reserved_micros is always the sum of the bill's call_reservations, whoever adds or removes
-- one (the call gate, the usage posting, the stale sweep, a call deleted with its workspace).
create or replace function call_reservations_sum() returns trigger as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    update billing_balances set reserved_micros = reserved_micros - old.reserved_micros, updated_at = now()
    where billing_account_id = old.billing_account_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    insert into billing_balances (billing_account_id, reserved_micros) values (new.billing_account_id, new.reserved_micros)
    on conflict (billing_account_id) do update
      set reserved_micros = billing_balances.reserved_micros + excluded.reserved_micros, updated_at = now();
  end if;
  return null;
end $$ language plpgsql;
--> statement-breakpoint
create trigger call_reservations_reserved_sum after insert or update or delete on call_reservations for each row
  execute function call_reservations_sum();
--> statement-breakpoint
-- A script or a test reset must not empty the reservations behind the reserved sum's back (TRUNCATE fires no row
-- triggers).
create or replace function call_reservations_no_truncate() returns trigger as $$
begin
  raise exception 'call_reservations cannot be truncated: delete the rows, so the reserved sums follow'
    using errcode = 'restrict_violation';
end $$ language plpgsql;
--> statement-breakpoint
create trigger call_reservations_no_truncate before truncate on call_reservations for each statement
  execute function call_reservations_no_truncate();
--> statement-breakpoint
-- billing_balances.balance_micros is always the sum of the bill's ledger: every entry moves it in the same
-- statement, whichever code posts it. The upsert takes the bill's balance row lock (lock order: balance row first).
create or replace function ledger_entries_balance() returns trigger as $$
begin
  insert into billing_balances (billing_account_id, balance_micros) values (new.billing_account_id, new.amount_micros)
  on conflict (billing_account_id) do update
    set balance_micros = billing_balances.balance_micros + excluded.balance_micros, updated_at = now();
  return null;
end $$ language plpgsql;
--> statement-breakpoint
create trigger ledger_entries_balance after insert on ledger_entries for each row
  execute function ledger_entries_balance();
