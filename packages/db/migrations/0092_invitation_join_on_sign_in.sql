-- Invitations a server admin made together with the account join at the first verified sign-in (LIN-246). Expand only:
-- the previous release ignores the column.
ALTER TABLE "invitation" ADD COLUMN "join_on_sign_in" boolean DEFAULT false NOT NULL;