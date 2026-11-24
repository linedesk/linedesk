// Providers in the terminal, for headless installs and AI agents (`scripts/setup.sh --check`):
//   node --env-file-if-exists=.env apps/api/src/setup-check.ts      (docker: docker compose exec api node apps/api/src/setup-check.ts)
// Tests every provider that is set up (provider.test as the operator, once per provider, logged like any admin
// action: the free key check, never a paid round trip) and prints each group the way Server admin › Providers shows it,
// with the steps for what is missing. Exit code 0 when every group a call needs works, 1 when something is missing or
// failing, 2 when the check itself could not run. Never prints a key.
import {
  callAudioGuideIn,
  type GroupStatus,
  oneKey,
  oneKeyIn,
  type ProviderGuide,
  providerGuide,
  providerSpec,
  providersOfGroup,
  recommendedProviders,
  statusText,
} from '@linedesk/actions'
import type { Actor } from './context.ts'
import { db, pool } from './db.ts'
import { runAction } from './run-action.ts'
import { providerFacts, setupChecklist } from './setup-checklist.ts'

const operator: Actor = {
  actorId: 'cli',
  role: 'member',
  workspaceId: null,
  permissions: ['instance:admin'],
  passkeyConfirmed: true,
}

const marks: Record<GroupStatus['state'], string> = {
  works: '[works]',
  failing: '[failing]',
  missing: '[not set up]',
  partly: '[partly]',
  checking: '[checking]',
  untested: '[not tested]',
  not_needed: '[not needed]',
  off: '[off]',
}

/** The steps of the provider we recommend for a group (call audio: the server's own). */
function guideOf(group: GroupStatus): { label: string | null; guide: ProviderGuide } {
  if (group.id === 'call-audio') return { label: null, guide: callAudioGuideIn() }
  const category = providerSpec(providersOfGroup(group.id)[0]!).category
  const recommended = group.id === 'answering' ? recommendedProviders.stt : recommendedProviders[category]
  return { label: providerSpec(recommended).label, guide: providerGuide(recommended) }
}

function print(group: GroupStatus) {
  const what = group.providerLabel ? `${group.providerLabel}: ` : ''
  console.log(
    `${marks[group.state].padEnd(13)} ${group.label.padEnd(18)} ${what}${statusText(group)}${group.message ? `. ${group.message}` : ''}`,
  )
  if (!group.needed || group.state === 'works') return
  if (group.state !== 'missing') return
  // The steps for a group that is not there yet; a failing one only needs its message (the fix).
  if (group.id === 'answering') {
    console.log(`              One key: ${oneKey.label} (${oneKey.url}). ${oneKeyIn().cost}`)
    console.log('              Or speech to text, a language model and a voice, e.g.:')
  }
  const { label, guide } = guideOf(group)
  if (guide.url) console.log(`              ${label ? `${label}: ` : ''}${guide.url}`)
  guide.steps.forEach((step, i) => console.log(`              ${i + 1}. ${step}`))
  console.log(`              Cost: ${guide.cost}`)
}

async function main() {
  // One free key check per provider that is set up and in use.
  for (const fact of await providerFacts(db))
    if (fact.configured && fact.active) await runAction('provider.test', { provider: fact.provider }, operator)
  const { groups, ready } = await setupChecklist(db)
  const needed = groups.filter(g => g.needed)
  console.log(
    `Providers: ${needed.filter(g => g.state === 'works').length} of ${needed.length} that calls need work.\n`,
  )
  for (const group of groups) print(group)
  console.log(
    ready
      ? '\nReady for calls. Next: open the app and set up the business.'
      : '\nKeys go in the app: Server admin › Providers.',
  )
  process.exitCode = ready ? 0 : 1
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 2
  })
  .finally(() => pool.end())
