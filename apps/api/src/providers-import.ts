// Moves provider keys from the environment into the app (Server admin › Providers), for an install that set
// them up in .env before they could be connected in the app:
//   pnpm --filter @linedesk/api providers:import            (docker: docker compose exec api node apps/api/src/providers-import.ts)
// Every registry field with a variable set and nothing stored yet is stored (provider.setKeys, as the
// operator), and so are push keys from VAPID_*. A value already stored in the app is kept. Afterwards
// the variables can go from .env: the stored values win anyway.
import { providerNames, providerSpec } from '@linedesk/actions'
import { provider_settings } from '@linedesk/db'
import { and, isNull } from 'drizzle-orm'
import type { Actor } from './context.ts'
import { db, pool } from './db.ts'
import { storePushKeys } from './instance-env.ts'
import { runAction } from './run-action.ts'

const operator: Actor = { actorId: 'cli', role: 'member', workspaceId: null, permissions: ['instance:admin'], passkeyConfirmed: true }

async function main() {
  const stored = new Set(
    (await db.select().from(provider_settings).where(and(isNull(provider_settings.workspace_id)))).map(
      row => `${row.provider}.${row.field}`,
    ),
  )
  const moved: string[] = []
  for (const provider of providerNames) {
    const values: Record<string, string> = {}
    for (const [field, spec] of Object.entries(providerSpec(provider).fields)) {
      const value = process.env[spec.env]?.trim()
      if (value && !stored.has(`${provider}.${field}`)) values[field] = value
    }
    if (!Object.keys(values).length) continue
    const { body } = await runAction('provider.setKeys', { provider, values }, operator)
    if (!body.ok) {
      console.error(`${providerSpec(provider).label}: not stored: ${body.error}`)
      continue
    }
    const names = Object.keys(values).map(field => providerSpec(provider).fields[field]!.env)
    moved.push(...names)
    console.log(`${providerSpec(provider).label}: stored ${names.join(', ')}`)
  }
  const pub = process.env.VAPID_PUBLIC_KEY?.trim()
  const priv = process.env.VAPID_PRIVATE_KEY?.trim()
  if (pub && priv && (await storePushKeys(db, pub, priv))) {
    moved.push('VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY')
    console.log('Push: stored VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (existing subscriptions keep working)')
  }
  console.log(
    moved.length
      ? `\nDone. These variables can go from .env now: ${moved.join(' ')}`
      : 'Nothing to move: no provider variables are set that are not stored in the app already.',
  )
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => pool.end())
