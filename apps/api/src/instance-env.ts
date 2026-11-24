// Settings from the admin area that the API keeps as environment variables. The sign-in providers are read once at
// start (Better Auth is built with them): server.ts loads them into process.env before it imports the app, so the
// stored value wins over the server's own variable, and a change in the admin area restarts the API (a few seconds);
// every API process also checks every 15 s, so one that did not handle the change follows. Email (SMTP or a mail
// service) applies without a restart: followEmailSettings copies the stored settings in again whenever they changed,
// right after the admin's change committed and in that 15 s check, and the sender (email.ts) follows process.env. Everything
// else in the admin area is read on every use (provider-settings.ts).
import { type ProviderName, providerNames, providerSpec, providersIn, restartCategories } from '@linedesk/actions'
import { instance_settings, provider_settings, type Tx } from '@linedesk/db'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import webpush from 'web-push'
import { mailServiceFromEnv } from './email-services.ts'
import { decryptSecret, encryptSecret, hasSecretsKey } from './secrets.ts'

type Env = Record<string, string | undefined>
type Db = Pick<Tx, 'select' | 'insert'>

/** Per environment: what the stored settings replaced, each variable's value from the server (undefined: not set). */
const overlays = new WeakMap<Env, Map<string, string | undefined>>()
const overlayOf = (env: Env) => {
  const overlay = overlays.get(env) ?? new Map<string, string | undefined>()
  overlays.set(env, overlay)
  return overlay
}

/** The server's own variables, without the stored settings copied in: the fallback the admin area shows. */
export function serverEnv(): Env {
  const overlay = overlays.get(process.env)
  if (!overlay?.size) return process.env
  return { ...process.env, ...Object.fromEntries(overlay) }
}

const setVariable = (env: Env, name: string, value: string) => {
  const overlay = overlayOf(env)
  if (!overlay.has(name)) overlay.set(name, env[name])
  env[name] = value
}

/** Puts a variable back to the server's own value (or unsets it), after a stored setting was removed. */
const resetVariable = (env: Env, name: string) => {
  const overlay = overlays.get(env)
  if (!overlay?.has(name)) return
  const value = overlay.get(name)
  if (value === undefined) delete env[name]
  else env[name] = value
}

type Row = typeof provider_settings.$inferSelect
const restartProviders = restartCategories.flatMap(category => providersIn(category))
const emailProviders = providersIn('email')

const storedRows = (db: Db, providers: readonly ProviderName[]) =>
  db
    .select()
    .from(provider_settings)
    .where(and(isNull(provider_settings.workspace_id), inArray(provider_settings.provider, [...providers])))

/** Changes whenever a stored setting of these rows, or the picked email provider, changes. */
const signatureOf = (
  rows: { provider: string; field: string; updated_at: string | Date }[],
  emailPick?: string | null,
) =>
  [
    ...rows.map(row => `${row.provider}.${row.field}@${new Date(row.updated_at).toISOString()}`).sort(),
    ...(emailPick === undefined ? [] : [`email:${emailPick ?? ''}`]),
  ].join(',')
const EMAIL_PICK = 'active_provider.email'

/** Copies stored rows into the environment. A value that cannot be decrypted is skipped. */
function copyRows(rows: Row[], env: Env) {
  for (const row of rows) {
    const spec = providerSpec(row.provider as ProviderName).fields[row.field]
    if (!spec) continue
    try {
      setVariable(env, spec.env, decryptSecret(row.value_encrypted, `${row.provider}.${row.field}`))
    } catch {
      console.error(
        `${row.provider} ${row.field}: the stored value cannot be decrypted (SECRETS_KEY changed?); set it again in Server admin › Providers`,
      )
    }
  }
}

let loadedSignature: string | null = null
/** The settings this process started with; unlike loadedSignature never moved on, so a pending change stays visible. */
let bootSignature: string | null = null
let loadedEmailProvider: ProviderName = 'smtp'
/** followEmailSettings' reads in the order they started, and the latest one applied. */
let emailReads = 0
let emailApplied = 0
/** Per environment: the stored email settings it holds now (followEmailSettings). */
const emailSignatures = new WeakMap<Env, string>()
const isProviderName = (name: string): name is ProviderName => (providerNames as string[]).includes(name)
/** The email provider this process sends with: a mail service (Resend, Gmail, ...) or plain SMTP. */
export const emailProviderInUse = (): ProviderName => loadedEmailProvider

/** Every variable the stored email settings may set: each email provider's fields, and what a mail service becomes. */
const emailVariables = [
  ...new Set([
    ...emailProviders.flatMap(provider => Object.values(providerSpec(provider).fields).map(field => field.env)),
    'SMTP_URL',
    'EMAIL_FROM',
  ]),
]

/**
 * Brings the email settings in the environment to what is stored (Server admin › Providers › Email), when they
 * changed since the last time: the sender (email.ts) uses them from the next email on, no restart. Called once a
 * change committed (admin-handlers.ts), never inside its transaction. True when something changed.
 */
export async function followEmailSettings(db: Db, env: Env = process.env): Promise<boolean> {
  // Reads that started earlier and finish later (a 15 s check that read before an admin's change committed) are
  // stale: only the latest read is applied.
  const read = ++emailReads
  const rows = await storedRows(db, emailProviders)
  const emailPick = await readSetting(db, EMAIL_PICK)
  if (read < emailApplied) return false
  emailApplied = read
  const signature = signatureOf(rows, emailPick)
  if (emailSignatures.get(env) === signature) return false
  // From here on synchronous: an email sent meanwhile sees the old settings or the new ones, never a mix.
  for (const name of emailVariables) resetVariable(env, name)
  copyRows(rows, env)
  // A mail service (Resend, Gmail, ...) sends as SMTP: its fields become SMTP_URL and EMAIL_FROM (email-services.ts).
  const service = emailPick ?? env.EMAIL_PROVIDER ?? null
  const mail = mailServiceFromEnv(service, env)
  if (mail) {
    setVariable(env, 'SMTP_URL', mail.url)
    if (mail.from) setVariable(env, 'EMAIL_FROM', mail.from)
  }
  if (env === process.env) loadedEmailProvider = mail && service && isProviderName(service) ? service : 'smtp'
  emailSignatures.set(env, signature)
  return true
}

/** Copies the stored sign-in and email settings into process.env. A value that cannot be decrypted is skipped. */
export async function loadInstanceEnv(db: Db, env: Env = process.env): Promise<void> {
  const rows = await storedRows(db, restartProviders)
  copyRows(rows, env)
  await followEmailSettings(db, env)
  loadedSignature = signatureOf(rows)
  bootSignature = loadedSignature
  await loadPushKeys(db, env).catch(error =>
    console.error('push notifications are off: could not load their keys', error),
  )
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

/**
 * Whether stored sign-in settings wait for a restart, and whether this process restarts by itself; under `pnpm dev`
 * the person restarts it. Email never waits: it applies at once (followEmailSettings).
 */
export async function restartState(db: Db): Promise<{ pending: boolean; automatic: boolean }> {
  if (bootSignature === null) return { pending: false, automatic: canRestart() }
  const signature = signatureOf(await storedRows(db, restartProviders))
  return { pending: signature !== bootSignature, automatic: canRestart() }
}

/** Follows changed email settings; restarts when the stored sign-in settings differ from what this process loaded. */
async function checkForChange(db: Db) {
  try {
    await followEmailSettings(db)
    const signature = signatureOf(await storedRows(db, restartProviders))
    if (loadedSignature === null || signature === loadedSignature) return
    restartToApply('Sign-in settings changed')
    if (!canRestart()) loadedSignature = signature // said once; `pnpm dev` is restarted by hand
  } catch (e) {
    console.error('could not check the sign-in and email settings', e)
  }
}

/**
 * After an admin changed sign-in or email settings: checks once the action's transaction has
 * committed, so a change that rolled back restarts nothing and leaves the email settings as stored
 * (the 15 s check is the safety net).
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
