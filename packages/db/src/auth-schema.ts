import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  boolean,
  check,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
  // Not Better Auth's: the operator of the install, independent of workspace roles (docs/architecture.md §12).
  instanceAdmin: boolean("instance_admin").default(false).notNull(),
  disabledAt: timestamp("disabled_at"),
  lastSignInAt: timestamp("last_sign_in_at"),
  // Not Better Auth's: a one-time code an instance admin without a passkey needs to add their first
  // (apps/api/src/passkey-enrolment.ts). Only its SHA-256 is kept.
  passkeyEnrolmentHash: text("passkey_enrolment_hash"),
  passkeyEnrolmentExpiresAt: timestamp("passkey_enrolment_expires_at"),
  // The UI language (apps/api/src/user-locale.ts): the person's choice, null for Automatic, and what Automatic last
  // resolved to in their browser (for emails).
  locale: text("locale"),
  localeAuto: text("locale_auto"),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activeOrganizationId: text("active_organization_id"),
    // Not Better Auth's admin plugin: set on a session an instance admin started as this user (docs/architecture.md §12).
    impersonatedBy: text("impersonated_by").references(() => user.id, { onDelete: "cascade" }),
    // Set when the session was started by a passkey sign-in; the admin area needs it (apps/api/src/admin-second-factor.ts).
    passkeyVerifiedAt: timestamp("passkey_verified_at"),
    // What set passkeyVerifiedAt: 'passkey' (a passkey sign-in) or 'authenticator' (a code from an instance admin's
    // authenticator app, the fallback; apps/api/src/authenticator.ts). Null on sessions from before: a passkey.
    secondFactorMethod: text("second_factor_method"),
    // White-label S5: the partner address (host name) the session was made on; null on the install's own address. The
    // session works only on that address (apps/api/src/context.ts), so a cookie taken there is useless anywhere else.
    host: text("host"),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const organization = pgTable(
  "organization",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    logo: text("logo"),
    createdAt: timestamp("created_at").notNull(),
    metadata: text("metadata"),
    // Not Better Auth's: set by an instance admin; calls to a disabled workspace are not answered.
    disabledAt: timestamp("disabled_at"),
    // Not Better Auth's: set by an instance admin. The workspace's monthly spending cap in US cents, on the
    // estimated cost (apps/api/src/spending-cap.ts); null: no cap.
    spendingCapCents: integer("spending_cap_cents"),
    // Not Better Auth's: the bill paying for this workspace (billing_accounts.id; docs/billing.md §4.1). Null:
    // unbilled (self-host, or comped by an instance admin). Its foreign key is in migration 0107 (billing_accounts
    // lives in schema.ts, which imports this file).
    billingAccountId: text("billing_account_id"),
    // The bill's state mirrored for a fast read on the call path; null while unbilled.
    billingState: text("billing_state", { enum: ["pending_payment", "active", "suspended"] }),
    // Not Better Auth's: the extra calls at once the bill owner bought for this workspace (LIN-450), on top of the
    // included ones; a multiple of EXTRA_CALLS_STEP (5), billed as the bill's extra-calls item in Stripe.
    extraCalls: integer("extra_calls").notNull().default(0),
    // Not Better Auth's: the white-label partner that runs this workspace for its client (partners.id,
    // docs/white-label.md); null: no partner. Its foreign key is in migration 0131 (partners lives in schema.ts).
    partnerId: text("partner_id"),
    // Not Better Auth's: a white-label client's monthly usage limit in US cents, set by its partner's team
    // (partner.setClientUsageLimit, apps/api/src/usage-limit.ts), measured on the ledger of the bill's current period;
    // null: no limit.
    usageLimitCents: integer("usage_limit_cents"),
  },
  (table) => [
    uniqueIndex("organization_slug_uidx").on(table.slug),
    index("organization_billing_account_idx").on(table.billingAccountId),
    index("organization_partner_idx").on(table.partnerId),
    check(
      "organization_billing_state",
      sql`${table.billingState} is null or ${table.billingState} in ('pending_payment', 'active', 'suspended')`,
    ),
    check("organization_extra_calls", sql`${table.extraCalls} between 0 and 1000 and ${table.extraCalls} % 5 = 0`),
    check(
      "organization_usage_limit",
      sql`${table.usageLimitCents} is null or ${table.usageLimitCents} between 100 and 10000000`,
    ),
  ],
);

export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").default("member").notNull(),
    createdAt: timestamp("created_at").notNull(),
    // Not Better Auth's: set on a membership that exists because the user is on this partner's team (partners.id,
    // docs/white-label.md). Such a membership is always `admin`, added and removed with the partner team; its foreign
    // key is in migration 0131.
    partnerId: text("partner_id"),
  },
  (table) => [
    index("member_organizationId_idx").on(table.organizationId),
    index("member_partner_idx").on(table.partnerId),
    // A partner admin is never the owner of a client workspace (the owner is the client).
    check("member_partner_admin", sql`${table.partnerId} is null or ${table.role} = 'admin'`),
    index("member_userId_idx").on(table.userId),
    // One membership per user and workspace: concurrent accepts and adds cannot make two.
    uniqueIndex("member_organization_user_uidx").on(table.organizationId, table.userId),
    // Exactly one owner per workspace (workspace rights, docs/architecture.md): a transfer demotes the owner first.
    uniqueIndex("member_one_owner_uidx").on(table.organizationId).where(sql`${table.role} = 'owner'`),
  ],
);

export const invitation = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Made by a server admin together with the account (Add user, Create workspace): the person joins at their
    // first verified sign-in, without a Join click (apps/api/src/memberships.ts, joinOnSignIn).
    joinOnSignIn: boolean("join_on_sign_in").default(false).notNull(),
  },
  (table) => [
    index("invitation_organizationId_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email),
  ],
);

// Better Auth's passkey plugin (WebAuthn). One row per registered credential; `publicKey` and
// `credentialID` are base64url, `counter` is the authenticator's signature counter.
export const passkey = pgTable(
  "passkey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    credentialID: text("credential_id").notNull(),
    counter: integer("counter").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    createdAt: timestamp("created_at"),
    aaguid: text("aaguid"),
  },
  (table) => [
    index("passkey_userId_idx").on(table.userId),
    uniqueIndex("passkey_credentialID_uidx").on(table.credentialID),
  ],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  members: many(member),
  invitations: many(invitation),
  passkeys: many(passkey),
}));

export const passkeyRelations = relations(passkey, ({ one }) => ({
  user: one(user, {
    fields: [passkey.userId],
    references: [user.id],
  }),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const organizationRelations = relations(organization, ({ many }) => ({
  members: many(member),
  invitations: many(invitation),
}));

export const memberRelations = relations(member, ({ one }) => ({
  organization: one(organization, {
    fields: [member.organizationId],
    references: [organization.id],
  }),
  user: one(user, {
    fields: [member.userId],
    references: [user.id],
  }),
}));

export const invitationRelations = relations(invitation, ({ one }) => ({
  organization: one(organization, {
    fields: [invitation.organizationId],
    references: [organization.id],
  }),
  user: one(user, {
    fields: [invitation.inviterId],
    references: [user.id],
  }),
}));
