// The instance setup checklist in the terminal, for headless installs and AI agents (`scripts/setup.sh --check`):
//   node --env-file-if-exists=.env apps/api/src/setup-check.ts      (docker: docker compose exec api node apps/api/src/setup-check.ts)
// Tests every provider that has keys (provider.test as the operator, once per provider, logged like any admin
// action) and prints what is missing with the steps to set it up. Exit code 0 when every part works, 1 when
// something is missing or failing, 2 when the check itself could not run. Never prints a key.
import {
  oneKey,
  type ProviderName,
  providerSpec,
  providersIn,
  type SetupChecklistItem,
  setupItemSpec,
} from '@linedesk/actions'
import type { Actor } from './context.ts'
import { db, pool } from './db.ts'
import { runAction } from './run-action.ts'
import { setupChecklist } from './setup-checklist.ts'

const operator: Actor = {
  actorId: 'cli',
  role: 'member',
  workspaceId: null,
  permissions: ['instance:admin'],
  passkeyConfirmed: true,
}

const marks: Record<SetupChecklistItem['state'], string> = {
  ok: '[ok]     ',
  set_up: '[untested]',
  failing: '[failing]',
  missing: '[missing]',
}

function print(item: SetupChecklistItem) {
  const spec = setupItemSpec(item.id)
  const label = item.providerLabel
  const what = label && !item.coveredBy && !item.message?.startsWith(label) ? `${label}: ` : ''
  const mark = item.id === 'livekit' && item.state === 'set_up' ? '[partly]' : marks[item.state]
  console.log(`${mark.padEnd(10)} ${item.label.padEnd(16)} ${what}${item.message ?? 'not set up'}`)
  if (item.state === 'ok') return
  // Covered by the realtime model: its key is the one to fix.
  console.log(`           ${item.coveredBy ? oneKey.url : spec.guide.url}`)
  // The steps for a part that is not there yet; a failing one only needs the place to fix it.
  if (item.state !== 'missing') return
  spec.guide.steps.forEach((step, i) => console.log(`           ${i + 1}. ${step}`))
  console.log(`           Cost: ${spec.guide.cost}`)
  const others = spec.category ? providersIn(spec.category).filter(p => p !== spec.guide.provider) : []
  if (others.length)
    console.log(`           Or: ${others.map(p => providerSpec(p).label).join(', ')} (Admin, Providers)`)
}

async function main() {
  const before = await setupChecklist(db)
  // One test per provider: rows covered by the realtime model share its result.
  const providers = new Set<ProviderName>()
  for (const item of before.items) if (item.provider && item.state !== 'missing') providers.add(item.provider)
  for (const provider of providers) {
    // A refused test (SECRETS_KEY missing or wrong) already shows on its row.
    await runAction('provider.test', { provider }, operator)
  }
  const checklist = await setupChecklist(db)
  console.log(`Instance setup: ${checklist.ready} of ${checklist.items.length} parts work.\n`)
  for (const item of checklist.items) print(item)
  const voiceMissing = checklist.items.some(i => ['stt', 'llm', 'tts'].includes(i.id) && i.state === 'missing')
  if (voiceMissing)
    console.log(
      `\nOne key instead: an ${oneKey.label} key covers speech, model and voice (${oneKey.url}). Connect it in Admin, Overview, or as OpenAI Realtime under Admin, Providers.`,
    )
  console.log(
    checklist.complete
      ? '\nEverything works. Next: open the app and set up the business.'
      : '\nKeys go in the app: Admin, Providers (or Admin, Overview).',
  )
  process.exitCode = checklist.complete ? 0 : 1
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 2
  })
  .finally(() => pool.end())
