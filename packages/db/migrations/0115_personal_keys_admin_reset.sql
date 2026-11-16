-- LIN-339 security review M3: Server admin on a personal key now needs a passkey sign-in (not an authenticator-app
-- code) and lasts 30 days. Keys made before could carry it from an authenticator code: none keeps it. An admin makes a
-- new key after a passkey sign-in.
UPDATE "personal_keys" SET "passkey_confirmed" = false WHERE "passkey_confirmed" = true;
