import { serve } from '@hono/node-server'
import { initErrorReporting } from './error-reporting.ts'
import { agentTokenProblem } from '@linedesk/actions'
import { db } from './db.ts'
import { emailProviderInUse, loadInstanceEnv, watchInstanceEnv } from './instance-env.ts'

// Sentry, when SENTRY_DSN is set (error-reporting.ts). Before the rest of the startup; the static imports above run first.
initErrorReporting('api')

// Sign-in providers and SMTP stored in the admin area, before the modules that read them load (instance-env.ts).
await loadInstanceEnv(db).catch(error => console.error('could not load the sign-in and email settings:', error))
watchInstanceEnv(db)
// The product name and logo an admin set (branding.ts), before the first email or page.
const { refreshBranding, watchBranding } = await import('./branding.ts')
await refreshBranding(db).catch(error => console.error('could not load the branding:', error))
watchBranding(db)
// A fresh install: the setup code for the first admin goes to the log (setup.ts).
await (await import('./setup.ts')).issueSetupCode(db).catch(error => console.error('could not make a setup code:', error))
const { passkeysOffWarning, secondFactorOffWarning } = await import('./admin-second-factor.ts')
// Instance admins without a passkey: Server admin needs one, so each gets an enrolment code in the log (admin-passkey-codes.ts).
await (await import('./admin-passkey-codes.ts'))
  .printMissingAdminEnrolments()
  .catch(error => console.error('could not issue passkey enrolment codes:', error))
const { app } = await import('./app.ts')
// Every email's result goes into the provider failure record (provider-failures.ts).
const { watchEmailFailures } = await import('./provider-failures.ts')
watchEmailFailures(emailProviderInUse)
const { startJobs, stopJobs } = await import('./jobs.ts')
const { startOrphanRecordingSweep } = await import('./orphan-recordings.ts')
const { startStaleCallSweep } = await import('./stale-calls.ts')

// A short or placeholder agent token could be guessed: refuse to start (docker/api-entrypoint.sh turns the placeholders off first).
const agentToken = process.env.AGENT_API_TOKEN
const agentTokenRefused = agentToken && agentTokenProblem(agentToken, { production: process.env.NODE_ENV === 'production' })
if (agentTokenRefused) {
  console.error(agentTokenRefused)
  process.exit(1)
}

const port = Number(process.env.PORT ?? 3000)
const offWarning = secondFactorOffWarning() ?? passkeysOffWarning()
if (offWarning) console.warn(offWarning)
const signUpWarning = (await import('./auth-methods.ts')).signUpSettingRemovedWarning()
if (signUpWarning) console.warn(signUpWarning)
const workspaceLimitWarning = (await import('./workspace-creation.ts')).workspaceLimitRemovedWarning()
if (workspaceLimitWarning) console.warn(workspaceLimitWarning)
// Live calls whose agent went away are ended after a while (stale-calls.ts).
startStaleCallSweep(db)
// Recording files the agent never reported are linked to their calls (orphan-recordings.ts).
startOrphanRecordingSweep(db)

const server = serve({ fetch: app.fetch, port }, () => console.log(`api on http://localhost:${port}`))

// Jobs failing to start must not take the API down: requests keep working, the jobs wait for a restart.
startJobs().catch(error => console.error('jobs could not start:', error))
// Linedesk's Telnyx voice profiles get the allowed countries and the spend limits again (outbound-policy.ts), so an
// update brings older profiles to them. In the background, never blocking the start: it retries with backoff, logs
// ALERT lines and records unconfirmed profiles for Server admin › System; it never throws.
void (await import('./outbound-policy.ts')).syncTelnyxProfiles()

// Stop on SIGTERM/SIGINT (as PID 1 in a container Node would ignore them): finish open requests,
// but don't wait for long-lived sync streams.
function shutdown() {
  void stopJobs().catch(() => {})
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
