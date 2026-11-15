import { readFileSync } from 'node:fs'
import { expect, test, vi } from 'vitest'
import { confirmErrorText, deleteWorkspaceText, workspaceActions } from './actions.tsx'
import type { AdminWorkspace } from './api.ts'
import { StepUpRequired } from './PasskeyStepUp.tsx'

const workspace = {
  id: 'ws-1',
  name: 'Brightwater Plumbing',
  members: 3,
  members_only_here: 1,
  calls_total: 12,
  contacts: 1,
  phone_numbers: [],
} as unknown as AdminWorkspace

test('deleting a workspace lists what goes, as Workspace settings does, and says it cannot be undone', () => {
  const text = deleteWorkspaceText(workspace)
  expect(text.after).toBe('This cannot be undone.')
  expect(text.list).toEqual([
    '12 calls, with their transcripts and recordings',
    '1 contact',
    '0 phone numbers',
    'Its bookings, settings and invitations',
    'The access of 3 other members; each of them gets an email that it was deleted',
    '1 account will be deleted because it has no other workspace',
  ])
  expect(text.option).toBe('Keep their accounts')
})

test('an admin who is a member is not counted among the other members', () => {
  const text = deleteWorkspaceText({ ...workspace, members: 2, members_only_here: 0 }, true)
  expect(text.list).toContain('The access of 1 other member; each of them gets an email that it was deleted')
  expect(deleteWorkspaceText({ ...workspace, members: 1, members_only_here: 0 }, true).list).toEqual([
    '12 calls, with their transcripts and recordings',
    '1 contact',
    '0 phone numbers',
    'Its bookings, settings and invitations',
  ])
  expect(deleteWorkspaceText({ ...workspace, members: 1, members_only_here: 0 }, true).option).toBeUndefined()
})

test('the delete sends keepAccounts and keepUsers with the same value, and its button is red as in Workspace settings', async () => {
  const sent: unknown[] = []
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)))
    return new Response(JSON.stringify({ data: { usersDeleted: [], numbers: [] } }), { status: 200 })
  })
  try {
    const remove = workspaceActions(workspace, async () => {}).find(a => a.id === 'delete')!
    expect(remove.danger).toBe(true)
    await remove.run(true)
    // Both names with the same value for this release: an older API reads only keepUsers.
    expect(sent).toEqual([{ workspaceId: 'ws-1', name: 'Brightwater Plumbing', keepAccounts: true, keepUsers: true }])
    await remove.run(false)
    expect(sent[1]).toEqual({
      workspaceId: 'ws-1',
      name: 'Brightwater Plumbing',
      keepAccounts: false,
      keepUsers: false,
    })
  } finally {
    vi.unstubAllGlobals()
  }
})

test('a failed confirmation says why in one short sentence, never a raw error', () => {
  expect(confirmErrorText(new StepUpRequired('Confirm with your passkey to do this.', 'confirm'))).toBe(
    'Not confirmed with your passkey. Nothing changed.',
  )
  expect(confirmErrorText(new TypeError('Failed to fetch'))).toBe(
    "Can't reach the server. Check your connection and try again.",
  )
  expect(confirmErrorText(new Error('The server answered 502'))).toBe(
    'Something went wrong on the server. Try again in a moment.',
  )
  expect(confirmErrorText(new Error('The name does not match'))).toBe('The name does not match.')
})

test('the passkey dialog comes last in admin, so it opens over a confirm dialog that waits for it', () => {
  // Both are fixed overlays on the same layer: the later one in the page is on top. Before it, the passkey a
  // delete asked for opened under the delete dialog, whose button then spun forever.
  const source = readFileSync(new URL('./AdminMode.tsx', import.meta.url), 'utf8')
  expect(source.indexOf('<PasskeyStepUpHost />')).toBeGreaterThan(source.indexOf('</main>'))
})

test('in the install setup too, the passkey dialog comes after the steps, so it opens over a provider dialog', () => {
  // Before, it came first: saving email keys without a passkey opened "Add a passkey first" under the
  // provider dialog, whose Save then spun forever with Cancel disabled.
  const source = readFileSync(new URL('../onboarding/InstallSetup.tsx', import.meta.url), 'utf8')
  expect(source.indexOf('<PasskeyStepUpHost />')).toBeGreaterThan(source.indexOf('<PartStep'))
})

test('an admin without a passkey is told how to add one, not a raw refusal', () => {
  expect(confirmErrorText(new StepUpRequired('This needs a passkey.', 'enrol'))).toBe(
    'Add a passkey first under Account › Sign-in & security, with the enrolment code from another admin or from user:passkeys --enrol on the server. Nothing changed.',
  )
})
