import { serve } from '@hono/node-server'
import { app } from './app.ts'
import { db } from './db.ts'
import { startJobs, stopJobs } from './jobs.ts'
import { startStaleCallSweep } from './stale-calls.ts'

const port = Number(process.env.PORT ?? 3000)
// Live calls whose agent went away are ended after a while (stale-calls.ts).
startStaleCallSweep(db)

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
