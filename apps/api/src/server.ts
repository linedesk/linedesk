import { serve } from '@hono/node-server'
import { agentTokenProblem } from '@linedesk/actions'
import { secondFactorOffWarning } from './admin-second-factor.ts'
import { app } from './app.ts'
import { db } from './db.ts'
import { startJobs, stopJobs } from './jobs.ts'
import { startOrphanRecordingSweep } from './orphan-recordings.ts'
import { startStaleCallSweep } from './stale-calls.ts'

// A short or placeholder agent token could be guessed: refuse to start (docker/api-entrypoint.sh turns the placeholders off first).
const agentToken = process.env.AGENT_API_TOKEN
const agentTokenRefused = agentToken && agentTokenProblem(agentToken, { production: process.env.NODE_ENV === 'production' })
if (agentTokenRefused) {
  console.error(agentTokenRefused)
  process.exit(1)
}

const port = Number(process.env.PORT ?? 3000)
const offWarning = secondFactorOffWarning()
if (offWarning) console.warn(offWarning)
// Live calls whose agent went away are ended after a while (stale-calls.ts).
startStaleCallSweep(db)
// Recording files the agent never reported are linked to their calls (orphan-recordings.ts).
startOrphanRecordingSweep(db)

const server = serve({ fetch: app.fetch, port }, () => console.log(`api on http://localhost:${port}`))

// Jobs failing to start must not take the API down: requests keep working, the jobs wait for a restart.
startJobs().catch(error => console.error('jobs could not start:', error))

// Stop on SIGTERM/SIGINT (as PID 1 in a container Node would ignore them): finish open requests,
// but don't wait for long-lived sync streams.
function shutdown() {
  void stopJobs().catch(() => {})
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
