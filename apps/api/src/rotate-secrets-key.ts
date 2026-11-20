// Moves everything stored with SECRETS_KEY to a new key, in one transaction: provider keys (install-wide, a
// workspace's own carrier and a white-label partner's own keys), webhook signing secrets, calendar, connected-app and mailbox tokens, the push key pair's private
// half, the port-out PINs of numbers (billing_numbers; security review of #920, L2) and the instance admins'
// authenticator app secrets (admin_authenticators; LIN-402).
// Run it in the api container, with the current SECRETS_KEY in its environment and the new key on stdin
// (never as an argument, which `ps` shows):
//   openssl rand -base64 32 > new-key.txt
//   docker compose exec -T api node apps/api/src/rotate-secrets-key.ts < new-key.txt            # check only
//   docker compose exec -T api node apps/api/src/rotate-secrets-key.ts --apply < new-key.txt    # rotate
// Then put the new key into SECRETS_KEY in .env and recreate the API at once: until then the running API holds
// the old key and cannot read what was rotated. Links the API signed with the old key (recording links) stop
// working. Back up the database first. It prints counts only, never a value.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  admin_authenticators,
  app_connections,
  app_credentials,
  billing_numbers,
  calendar_connections,
  calendar_credentials,
  instance_settings,
  mail_credentials,
  partner_providers,
  provider_settings,
  type Tx,
  webhook_secrets,
} from '@linedesk/db'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { appSlot } from './app-connections.ts'
import { authenticatorSlot } from './authenticator.ts'
import { mailSlot } from './mail-connections.ts'
import { portOutSlot } from './billing-owner.ts'
import { calendarSlot } from './calendar-connections.ts'
import { db, pool } from './db.ts'
import { VAPID_PRIVATE } from './instance-env.ts'
import { partnerKeySlot } from './partner-keys.ts'
import { providerSlot } from './provider-settings.ts'
import { decryptSecret, parseSecretsKey, reencryptSecret } from './secrets.ts'
import { secretSlot } from './webhooks.ts'
import { carrierSlot } from './workspace-carrier.ts'

/**
 * Re-encrypts every stored secret from key `from` to key `to` in the caller's transaction, and reads one back under
 * `to`. Each value is decrypted with `from` first: one that does not decrypt throws before the commit. The counts.
 */
export async function reencryptSecrets(tx: Tx, from: Buffer, to: Buffer) {
  const again = (stored: string, slot: string) => reencryptSecret(stored, slot, from, to)
  const providers = await tx.select().from(provider_settings)
  for (const row of providers) {
    const slot = row.workspace_id
      ? carrierSlot(row.workspace_id, row.provider, row.field)
      : providerSlot(row.provider, row.field)
    await tx
      .update(provider_settings)
      .set({ value_encrypted: again(row.value_encrypted, slot) })
      .where(eq(provider_settings.id, row.id))
  }
  // A white-label partner's own provider keys (S7): their own table, bound to partner, stage and provider.
  const partnerKeys = await tx.select().from(partner_providers)
  for (const row of partnerKeys) {
    await tx
      .update(partner_providers)
      .set({ key_encrypted: again(row.key_encrypted, partnerKeySlot(row.partner_id, row.category, row.provider)) })
      .where(and(eq(partner_providers.partner_id, row.partner_id), eq(partner_providers.category, row.category)))
  }
  const webhooks = await tx.select().from(webhook_secrets)
  for (const row of webhooks) {
    await tx
      .update(webhook_secrets)
      .set({ secret_encrypted: again(row.secret_encrypted, secretSlot(row.endpoint_id)) })
      .where(eq(webhook_secrets.endpoint_id, row.endpoint_id))
  }
  const calendars = await tx
    .select({ credentials: calendar_credentials, provider: calendar_connections.provider })
    .from(calendar_credentials)
    .innerJoin(calendar_connections, eq(calendar_connections.id, calendar_credentials.connection_id))
  for (const { credentials: row, provider } of calendars) {
    const connection = { id: row.connection_id, provider }
    await tx
      .update(calendar_credentials)
      .set({
        access_token_encrypted: again(row.access_token_encrypted, calendarSlot(connection, 'access')),
        refresh_token_encrypted: again(row.refresh_token_encrypted, calendarSlot(connection, 'refresh')),
      })
      .where(eq(calendar_credentials.connection_id, row.connection_id))
  }
  const apps = await tx
    .select({ credentials: app_credentials, provider: app_connections.provider })
    .from(app_credentials)
    .innerJoin(app_connections, eq(app_connections.id, app_credentials.connection_id))
  for (const { credentials: row, provider } of apps) {
    const connection = { id: row.connection_id, provider }
    await tx
      .update(app_credentials)
      .set({
        access_token_encrypted: again(row.access_token_encrypted, appSlot(connection, 'access')),
        refresh_token_encrypted: again(row.refresh_token_encrypted, appSlot(connection, 'refresh')),
        webhook_url_encrypted:
          row.webhook_url_encrypted && again(row.webhook_url_encrypted, appSlot(connection, 'webhook')),
      })
      .where(eq(app_credentials.connection_id, row.connection_id))
  }
  const mailboxes = await tx.select().from(mail_credentials)
  for (const row of mailboxes)
    await tx
      .update(mail_credentials)
      .set({
        access_token_encrypted: again(row.access_token_encrypted, mailSlot(row.connection_id, 'access')),
        refresh_token_encrypted: again(row.refresh_token_encrypted, mailSlot(row.connection_id, 'refresh')),
      })
      .where(eq(mail_credentials.connection_id, row.connection_id))
  const [push] = await tx.select().from(instance_settings).where(eq(instance_settings.key, VAPID_PRIVATE))
  if (push)
    await tx
      .update(instance_settings)
      .set({ value: again(push.value, VAPID_PRIVATE) })
      .where(eq(instance_settings.key, VAPID_PRIVATE))
  // Port-out PINs: without them an owner cannot see their PIN after a rotation (billing.portOutInfo throws).
  const pins = await tx
    .select({ id: billing_numbers.phone_number_id, code: billing_numbers.port_out_code })
    .from(billing_numbers)
    .where(isNotNull(billing_numbers.port_out_code))
  for (const row of pins)
    await tx
      .update(billing_numbers)
      .set({ port_out_code: again(row.code!, portOutSlot(row.id)) })
      .where(eq(billing_numbers.phone_number_id, row.id))
  // Authenticator app secrets: without them every instance admin's authenticator app stops working after a rotation.
  const authenticators = await tx
    .select({ userId: admin_authenticators.user_id, secret: admin_authenticators.secret })
    .from(admin_authenticators)
  for (const row of authenticators)
    await tx
      .update(admin_authenticators)
      .set({ secret: again(row.secret, authenticatorSlot(row.userId)) })
      .where(eq(admin_authenticators.user_id, row.userId))
  // Read back under the new key before the commit.
  const [check] = await tx.select().from(provider_settings).where(isNull(provider_settings.workspace_id)).limit(1)
  if (check) decryptSecret(check.value_encrypted, providerSlot(check.provider, check.field), to)
  return {
    provider_settings: providers.length,
    partner_providers: partnerKeys.length,
    webhook_secrets: webhooks.length,
    calendar_credentials: calendars.length,
    app_credentials: apps.length,
    mail_credentials: mailboxes.length,
    push_key: push ? 1 : 0,
    port_out_pins: pins.length,
    admin_authenticators: authenticators.length,
  }
}

async function rotate(apply: boolean) {
  const from = parseSecretsKey(process.env.SECRETS_KEY ?? '')
  const to = parseSecretsKey(readFileSync(0, 'utf8'))
  if (from.equals(to)) throw new Error('The new key is the current SECRETS_KEY.')
  let counts: Record<string, number> = {}
  await db
    .transaction(async tx => {
      counts = await reencryptSecrets(tx, from, to)
      if (!apply) tx.rollback()
    })
    .catch(error => {
      // drizzle's rollback() throws to end the transaction; for a check that is the expected way out.
      if (apply || error?.constructor?.name !== 'TransactionRollbackError') throw error
    })
  return counts
}

// Run as a script only (the test imports reencryptSecrets).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const apply = process.argv.includes('--apply')
  rotate(apply)
    .then(counts => {
      if (apply)
        console.log(
          `Rotated to the new key: ${JSON.stringify(counts)}. Now set SECRETS_KEY in .env to it and recreate the API.`,
        )
      else
        console.log(
          `Check passed, every value decrypts with the current key: ${JSON.stringify(counts)}. Nothing changed; --apply rotates.`,
        )
    })
    .catch(error => {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    })
    .finally(() => pool.end())
}
