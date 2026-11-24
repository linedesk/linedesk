// The setup code of an install without users, from the server's shell (setup.ts): for when the log line has scrolled
// away, or the code should be replaced (it was seen by someone it should not have been).
//   node apps/api/src/setup-code.ts          prints the current code (a new one if it is older than 7 days)
//   node apps/api/src/setup-code.ts --new    replaces it with a new one and prints that
// docker: docker compose exec api node apps/api/src/setup-code.ts [--new]
import { parseArgs } from 'node:util'
import { db, pool } from './db.ts'
import { issueSetupCode } from './setup.ts'

async function main() {
  const { values } = parseArgs({ options: { new: { type: 'boolean' } } })
  const issued = await db.transaction(tx => issueSetupCode(tx, { fresh: !!values.new }))
  if (!issued) throw new Error('This install has an account already, so it needs no setup code. Sign in instead.')
}

main()
  .catch(e => {
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
  .finally(() => pool.end())
