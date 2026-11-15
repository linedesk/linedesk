// The loading standard (docs/design-principles.md rule 15), checked over the web app's source so a new screen can't
// quietly miss it: no "Loading…" text, spinners only in buttons the user pressed, and every component that reads data
// uses the shared loading states (ui/LoadStates.tsx) unless it is listed below with the reason it needs none.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, test } from 'vitest'

const SRC = join(import.meta.dirname, '..')

function sources(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [relative(SRC, path)] : []
  })
}
const files = sources().map(path => ({ path, text: readFileSync(join(SRC, path), 'utf8') }))
/** The source without comments, so a comment that names the rule ("no Loading… text") doesn't count. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

test('no "Loading…" text anywhere: skeletons show that something loads, screen readers get aria-busy', () => {
  // The boot screen before the session is known is the rule's one exception (store.tsx BootScreen).
  const allowed = new Set(['store.tsx'])
  const found = files.filter(f => !allowed.has(f.path) && /Loading(…|\.\.\.)/.test(code(f.text))).map(f => f.path)
  expect(found, 'Use Loading/Skeleton* from ui/LoadStates.tsx, or keep a pressed button busy (Button busy)').toEqual([])
})

/**
 * Where a bare <Spinner /> may stand, and how often: inside a button the user pressed (sign-in, passkey, create
 * workspace), the StatusMark "being checked" state, the kit's Button `busy`, and the setup page's "Waiting for your
 * agent" (a process the admin started, not page data). Page data never gets a spinner.
 */
const SPINNERS: Record<string, number> = {
  'ui/kit.tsx': 1,
  'ui/StatusMark.tsx': 1,
  'Login.tsx': 5,
  'AddPasskey.tsx': 1,
  'CreateWorkspace.tsx': 1,
  'admin/SecondFactorPrompt.tsx': 4,
  'onboarding/AgentSetup.tsx': 1,
}

test('spinners only in buttons the user pressed, never for page data', () => {
  const counts = Object.fromEntries(
    files.map(f => [f.path, (code(f.text).match(/<Spinner\b/g) ?? []).length] as const).filter(([, n]) => n > 0),
  )
  expect(counts, 'A spinner for page data: use a skeleton (ui/LoadStates.tsx) instead').toEqual(SPINNERS)
})

/**
 * Components that read data (useQuery, useLoadState) but show nothing that is always there while it loads, so
 * they need no skeleton. Everything else that reads data uses ui/LoadStates.tsx. A new entry needs a reason that
 * holds: "always shown" means it gets a skeleton of its shape.
 */
const NO_SKELETON_NEEDED: Record<string, string> = {
  'Login.tsx': 'the sign-in page has its own connecting state before the methods are known (boot)',
  'admin/Providers.tsx': 'the walkthrough button is off on Cloud, so it is not always shown; the agent button is',
  'call/EvaluationCard.tsx': 'shown only when the call has an evaluation, or for a test call',
  'onboarding/InstanceSetup.tsx': 'the notice shows only when a part of the server is missing or failing',
  'settings/CarrierNumberInput.tsx': 'the input works at once; the carrier numbers only add suggestions',
  'shell/WorkspaceSwitcher.tsx': 'shown only with more than one workspace or an invitation',
}

test('every component that reads data uses the shared loading states, or says why it needs none', () => {
  const reading = files
    .filter(f => f.path.endsWith('.tsx') && f.path !== 'ui/LoadStates.tsx')
    .filter(f => /\buse(Query|LoadState)\(/.test(code(f.text)) && !f.text.includes('LoadStates.tsx'))
    .map(f => f.path)
    .sort()
  expect(reading, 'Give its always-shown parts a skeleton (rule 15), or add it here with the reason').toEqual(
    Object.keys(NO_SKELETON_NEEDED).sort(),
  )
})
