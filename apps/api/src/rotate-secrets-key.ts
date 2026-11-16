// Moves everything stored with SECRETS_KEY to a new key, in one transaction: provider keys (install-wide and a
// workspace's own carrier), webhook signing secrets, calendar and connected-app tokens and the push key pair's private half.
// Run it in the api container, with the current SECRETS_KEY in its environment and the new key on stdin
// (never as an argument, which `ps` shows):
//   openssl rand -base64 32 > new-key.txt
//   docker compose exec -T api node apps/api/src/rotate-secrets-key.ts < new-key.txt            # check only
//   docker compose exec -T api node apps/api/src/rotate-secrets-key.ts --apply < new-key.txt    # rotate
// Then put the new key into SECRETS_KEY in .env and recreate the API at once: until then the running API holds
// the old key and cannot read what was rotated. Links the API signed with the old key (recording links) stop
// working. Back up the database first. It prints counts only, never a value.
import { readFileSync } from 'node:fs'
import { app_connections, app_credentials, calendar_connections, calendar_credentials, instance_settings, provider_settings, webhook_secrets } from '@linedesk/db'
import { eq, isNull } from 'drizzle-orm'
import { appSlot } from './app-connections.ts'
import { calendarSlot } from './calendar-connections.ts'
import { db, pool } from './db.ts'
import { VAPID_PRIVATE } from './instance-env.ts'
import { providerSlot } from './provider-settings.ts'
import { decryptSecret, parseSecretsKey, reencryptSecret } from './secrets.ts'
import { secretSlot } from './webhooks.ts'
import { carrierSlot } from './workspace-carrier.ts'

async function rotate(apply: boolean) {
  const from = parseSecretsKey(process.env.SECRETS_KEY ?? '')
  const to = parseSecretsKey(readFileSync(0, 'utf8'))
  if (from.equals(to)) throw new Error('The new key is the current SECRETS_KEY.')
  // Each value is decrypted with the current key first: one that does not decrypt stops everything before a write.
  const again = (stored: string, slot: string) => reencryptSecret(stored, slot, from, to)
  let counts: Record<string, number> = {}
  await db
    .transaction(async tx => {
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
          })
          .where(eq(app_credentials.connection_id, row.connection_id))
      }
      const [push] = await tx.select().from(instance_settings).where(eq(instance_settings.key, VAPID_PRIVATE))
      if (push)
        await tx
          .update(instance_settings)
          .set({ value: again(push.value, VAPID_PRIVATE) })
          .where(eq(instance_settings.key, VAPID_PRIVATE))
      // Read back under the new key before the commit.
      const [check] = await tx.select().from(provider_settings).where(isNull(provider_settings.workspace_id)).limit(1)
      if (check) decryptSecret(check.value_encrypted, providerSlot(check.provider, check.field), to)
      counts = {
        provider_settings: providers.length,
        webhook_secrets: webhooks.length,
        calendar_credentials: calendars.length,
        app_credentials: apps.length,
        push_key: push ? 1 : 0,
      }
      if (!apply) tx.rollback()
    })
    .catch(error => {
      // drizzle's rollback() throws to end the transaction; for a check that is the expected way out.
      if (apply || error?.constructor?.name !== 'TransactionRollbackError') throw error
    })
  return counts
}

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
