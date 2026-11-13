// Settings from the admin area that the API reads once at start, as environment variables: the
// sign-in providers (Better Auth is built with them) and SMTP (the mail transport). server.ts loads
// them into process.env before it imports the app, so the stored value wins over the server's own
// variable. A change in the admin area restarts the API (a few seconds); every API process also
// checks every 15 s, so one that did not handle the change follows. Everything else in the admin
// area is read on every use and needs no restart (provider-settings.ts).
import { type ProviderName, providerNames, providerSpec, providersIn, restartCategories } from '@linedesk/actions'
import { instance_settings, provider_settings, type Tx } from '@linedesk/db'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import webpush from 'web-push'
import { mailServiceFromEnv } from './email-services.ts'
import { decryptSecret, encryptSecret, hasSecretsKey } from './secrets.ts'

type Env = Record<string, string | undefined>
type Db = Pick<Tx, 'select' | 'insert'>

/** What loadInstanceEnv replaced in process.env: each variable's value from the server (undefined: not set). */
const overlaid = new Map<string, string | undefined>()

/** The server's own variables, without the stored settings copied in: the fallback the admin area shows. */
export function serverEnv(): Env {
  if (!overlaid.size) return process.env
  return { ...process.env, ...Object.fromEntries(overlaid) }
}

const setVariable = (env: Env, name: string, value: string) => {
  if (env === process.env && !overlaid.has(name)) overlaid.set(name, env[name])
  env[name] = value
}

const restartProviders = restartCategories.flatMap(category => providersIn(category))

const storedRows = (db: Db) =>
  db
    .select()
    .from(provider_settings)
    .where(and(isNull(provider_settings.workspace_id), inArray(provider_settings.provider, restartProviders)))

/** Changes whenever a stored sign-in or email setting, or the picked email provider, changes. */
const signatureOf = (rows: { provider: string; field: string; updated_at: string | Date }[], emailPick: string | null) =>
  [
    ...rows.map(row => `${row.provider}.${row.field}@${new Date(row.updated_at).toISOString()}`).sort(),
    `email:${emailPick ?? ''}`,
  ].join(',')
const EMAIL_PICK = 'active_provider.email'

let loadedSignature: string | null = null
let loadedEmailProvider: ProviderName = 'smtp'
const isProviderName = (name: string): name is ProviderName => (providerNames as string[]).includes(name)
/** The email provider this process sends with: a mail service (Resend, Gmail, ...) or plain SMTP. */
export const emailProviderInUse = (): ProviderName => loadedEmailProvider

/** Copies the stored sign-in and email settings into process.env. A value that cannot be decrypted is skipped. */
export async function loadInstanceEnv(db: Db, env: Env = process.env): Promise<void> {
  const rows = await storedRows(db)
  for (const row of rows) {
    const spec = providerSpec(row.provider as (typeof restartProviders)[number]).fields[row.field]
    if (!spec) continue
    try {
      setVariable(env, spec.env, decryptSecret(row.value_encrypted, `${row.provider}.${row.field}`))
    } catch {
      console.error(`${row.provider} ${row.field}: the stored value cannot be decrypted (SECRETS_KEY changed?); set it again in Admin, Providers`)
    }
  }
  // A mail service (Resend, Gmail, ...) sends as SMTP: its fields become SMTP_URL and EMAIL_FROM (email-services.ts).
  const emailPick = await readSetting(db, EMAIL_PICK)
  const mail = mailServiceFromEnv(emailPick ?? env.EMAIL_PROVIDER ?? null, env)
  const service = emailPick ?? env.EMAIL_PROVIDER ?? null
  loadedEmailProvider = mail && service && isProviderName(service) ? service : 'smtp'
  if (mail) {
    setVariable(env, 'SMTP_URL', mail.url)
    if (mail.from) setVariable(env, 'EMAIL_FROM', mail.from)
  }
  loadedSignature = signatureOf(rows, emailPick)
  await loadPushKeys(db, env).catch(error => console.error('push notifications are off: could not load their keys', error))
}

const VAPID_PUBLIC = 'push.vapid_public_key'
export const VAPID_PRIVATE = 'push.vapid_private_key'

const readSetting = async (db: Db, key: string) =>
  (await db.select().from(instance_settings).where(eq(instance_settings.key, key)))[0]?.value ?? null

/** Stores a key pair made elsewhere (providers-import.ts: VAPID_* from .env). False when a pair is stored already. */
export async function storePushKeys(db: Db, publicKey: string, privateKey: string): Promise<boolean> {
  if (await readSetting(db, VAPID_PUBLIC)) return false
  const now = new Date().toISOString()
  await db
    .insert(instance_settings)
    .values([
      { key: VAPID_PRIVATE, value: encryptSecret(privateKey, VAPID_PRIVATE), updated_at: now },
      { key: VAPID_PUBLIC, value: publicKey, updated_at: now },
    ])
    .onConflictDoNothing()
  return true
}

/**
 * The keys push notifications are signed with (VAPID). Nobody has to make them: the first start
 * makes a pair and stores it (the private key encrypted), every later start and every API process
 * uses the same pair, so subscriptions keep working. VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY on
 * the server still win. Without SECRETS_KEY nothing is stored and push stays off.
 */
async function loadPushKeys(db: Db, env: Env) {
  if (env.VAPID_PUBLIC_KEY?.trim() && env.VAPID_PRIVATE_KEY?.trim()) return
  if (!hasSecretsKey()) return
  if (!(await readSetting(db, VAPID_PUBLIC))) {
    // Two processes starting at once: the first pair stored wins, the other is dropped.
    const keys = webpush.generateVAPIDKeys()
    await storePushKeys(db, keys.publicKey, keys.privateKey)
  }
  const publicKey = await readSetting(db, VAPID_PUBLIC)
  const privateKey = await readSetting(db, VAPID_PRIVATE)
  if (!publicKey || !privateKey) return
  setVariable(env, 'VAPID_PUBLIC_KEY', publicKey)
  setVariable(env, 'VAPID_PRIVATE_KEY', decryptSecret(privateKey, VAPID_PRIVATE))
  // Push services want a way to reach the operator: the install's own address unless one is set.
  if (!env.VAPID_SUBJECT?.trim() && env.PUBLIC_URL?.startsWith('https://'))
    setVariable(env, 'VAPID_SUBJECT', new URL(env.PUBLIC_URL).origin)
}

/**
 * Whether this process may restart itself to apply a change: only where something starts it again
 * (docker/api-entrypoint.sh sets LINEDESK_SELF_RESTART=1; Docker's restart policy or dev mode's
 * runner does the rest). In `pnpm dev` the API says to restart it instead.
 */
const canRestart = (env: Env = process.env) => env.LINEDESK_SELF_RESTART === '1'

let restarting = false
/** Ends this process so it starts again with the stored settings. */
export function restartToApply(reason: string) {
  if (!canRestart()) {
    console.warn(`${reason}: restart the API to apply it.`)
    return
  }
  if (restarting) return
  restarting = true
  console.log(`${reason}: restarting the API to apply it.`)
  // After the current response went out.
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500).unref()
}

/** Restarts when the stored sign-in or email settings differ from what this process loaded. */
async function checkForChange(db: Db) {
  try {
    const signature = signatureOf(await storedRows(db), await readSetting(db, EMAIL_PICK))
    if (loadedSignature === null || signature === loadedSignature) return
    restartToApply('Sign-in or email settings changed')
    if (!canRestart()) loadedSignature = signature // said once; `pnpm dev` is restarted by hand
  } catch (e) {
    console.error('could not check the sign-in and email settings', e)
  }
}

/**
 * After an admin changed sign-in or email settings: checks once the action's transaction has
 * committed, so a change that rolled back restarts nothing (the 15 s check is the safety net).
 */
export function checkInstanceEnvSoon(db: Db, afterMs = 1500) {
  setTimeout(() => void checkForChange(db), afterMs).unref()
}

/** Checks every 15 s whether the stored sign-in or email settings changed since this process loaded them. */
export function watchInstanceEnv(db: Db, everyMs = 15_000) {
  const timer = setInterval(() => void checkForChange(db), everyMs)
  timer.unref()
  return () => clearInterval(timer)
}
