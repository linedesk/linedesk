-- LIN-772: outside addresses for call emails (LIN-769 removed adding them); dropped in one step before go-live (no backfill).
DROP TABLE "email_recipients" CASCADE;
