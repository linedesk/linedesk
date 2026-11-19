// The SECRETS_KEY rotation (src/rotate-secrets-key.ts): every stored secret moves to the new key, the port-out PINs
// of numbers too (security review of #920, L2) and the authenticator app secrets (LIN-402), in the caller's
// transaction. Instance-wide: it reads every stored secret of the install, so it has a database of its own.
import { randomBytes } from 'node:crypto'
import {
  admin_authenticators,
  app_connections,
  app_credentials,
  billing_accounts,
  billing_numbers,
  phone_numbers,
} from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { appSlot } from '../src/app-connections.ts'
import { authenticatorSlot } from '../src/authenticator.ts'
import { portOutSlot } from '../src/billing-owner.ts'
import { db } from '../src/db.ts'
import { reencryptSecrets } from '../src/rotate-secrets-key.ts'
import { decryptSecret, encryptSecret, parseSecretsKey } from '../src/secrets.ts'
import { createWorkspace, signUp } from './helpers.ts'

const rid = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`

test('a port-out PIN is re-encrypted with the new key and still reads under its own slot', async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const [number] = await db.select().from(phone_numbers).where(eq(phone_numbers.e164, ws.number))
  const billId = rid('bill')
  await db
    .insert(billing_accounts)
    .values({ id: billId, kind: 'cloud', owner_user_id: ws.owner.userId, status: 'active' })
  await db.insert(billing_numbers).values({
    phone_number_id: number!.id,
    billing_account_id: billId,
    port_out_code: encryptSecret('12345678', portOutSlot(number!.id)),
  })
  const from = parseSecretsKey(process.env.SECRETS_KEY!)
  const to = randomBytes(32)
  const rotated = await db
    .transaction(async tx => {
      const counts = await reencryptSecrets(tx, from, to)
      const [row] = await tx.select().from(billing_numbers).where(eq(billing_numbers.phone_number_id, number!.id))
      // Rolled back below: the rest of the run keeps the key in its environment.
      throw Object.assign(new Error('rollback'), { counts, stored: row!.port_out_code! })
    })
    .catch((e: { counts: Record<string, number>; stored: string }) => e)
  expect(rotated.counts.port_out_pins).toBe(1)
  expect(decryptSecret(rotated.stored, portOutSlot(number!.id), to)).toBe('12345678')
  expect(() => decryptSecret(rotated.stored, portOutSlot(number!.id), from)).toThrow()
})

test('an authenticator app secret is re-encrypted with the new key and still reads under its own slot', async () => {
  const admin = await signUp()
  await db.insert(admin_authenticators).values({
    user_id: admin.userId,
    secret: encryptSecret('JBSWY3DPEHPK3PXP', authenticatorSlot(admin.userId)),
    confirmed_at: new Date().toISOString(),
  })
  const from = parseSecretsKey(process.env.SECRETS_KEY!)
  const to = randomBytes(32)
  const rotated = await db
    .transaction(async tx => {
      const counts = await reencryptSecrets(tx, from, to)
      const [row] = await tx.select().from(admin_authenticators).where(eq(admin_authenticators.user_id, admin.userId))
      // Rolled back below: the rest of the run keeps the key in its environment.
      throw Object.assign(new Error('rollback'), { counts, stored: row!.secret })
    })
    .catch((e: { counts: Record<string, number>; stored: string }) => e)
  expect(rotated.counts.admin_authenticators).toBe(1)
  expect(decryptSecret(rotated.stored, authenticatorSlot(admin.userId), to)).toBe('JBSWY3DPEHPK3PXP')
  expect(() => decryptSecret(rotated.stored, authenticatorSlot(admin.userId), from)).toThrow()
  // Under another person's slot it does not read: a secret copied to another row stays useless.
  expect(() => decryptSecret(rotated.stored, authenticatorSlot('someone-else'), to)).toThrow()
})

test('a Slack webhook URL is re-encrypted with the new key, next to the tokens', async () => {
  const ws = await createWorkspace('Brightwater Plumbing & Heating')
  const connection = { id: rid('app'), provider: 'slack' as const }
  const url = 'https://hooks.slack.com/services/T000/B000/xyz'
  await db.insert(app_connections).values({
    ...connection,
    workspace_id: ws.id,
    account_id: 'T000',
    account_name: 'Brightwater',
    connected_by: ws.owner.userId,
  })
  await db.insert(app_credentials).values({
    connection_id: connection.id,
    workspace_id: ws.id,
    access_token_encrypted: encryptSecret('xoxb-1', appSlot(connection, 'access')),
    refresh_token_encrypted: encryptSecret('none', appSlot(connection, 'refresh')),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    webhook_url_encrypted: encryptSecret(url, appSlot(connection, 'webhook')),
  })
  const from = parseSecretsKey(process.env.SECRETS_KEY!)
  const to = randomBytes(32)
  const rotated = await db
    .transaction(async tx => {
      await reencryptSecrets(tx, from, to)
      const [row] = await tx.select().from(app_credentials).where(eq(app_credentials.connection_id, connection.id))
      throw Object.assign(new Error('rollback'), { stored: row!.webhook_url_encrypted! })
    })
    .catch((e: { stored: string }) => e)
  expect(decryptSecret(rotated.stored, appSlot(connection, 'webhook'), to)).toBe(url)
  expect(() => decryptSecret(rotated.stored, appSlot(connection, 'webhook'), from)).toThrow()
})
