import { readFileSync } from 'node:fs'
import { expect, test, vi } from 'vitest'
import {
  adminGrantText,
  confirmErrorText,
  deletedWorkspaceText,
  deleteWorkspaceText,
  existingPasskeysText,
  signInAsOwnerAction,
  userActions,
  workspaceActions,
} from './actions.tsx'
import type { AdminUser, AdminWorkspace } from './api.ts'
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

test('the toast after a delete counts the accounts and names the numbers left at the carrier', () => {
  expect(deletedWorkspaceText('Brightwater', { usersDeleted: [], numbers: [] })).toBe('Brightwater is deleted.')
  expect(deletedWorkspaceText('Brightwater', { usersDeleted: ['u1'] })).toBe(
    'Brightwater is deleted. 1 account deleted with it.',
  )
  expect(
    deletedWorkspaceText('Brightwater', {
      usersDeleted: ['u1', 'u2'],
      numbers: [
        { e164: '+15550100', carrier: 'left' },
        { e164: '+15550101', carrier: 'left', note: 'release it in Telnyx' },
        { e164: '+15550102', carrier: 'released' },
      ],
    }),
  ).toBe(
    'Brightwater is deleted. 2 accounts deleted with it. Still at the carrier: +15550100: left at the carrier; +15550101: release it in Telnyx.',
  )
})

test('granting server admin names the passkeys that already open the admin area', () => {
  expect(adminGrantText('Ana')).toBe(
    'Make Ana a server admin? They can see every workspace and user, change provider keys and sign in as other users.',
  )
  const one = existingPasskeysText([{ name: 'MacBook', device_type: 'singleDevice', created_at: null }] as never)
  expect(one).toMatch(/^They already have a passkey: MacBook\. These open the admin area for them\./)
  const two = existingPasskeysText([
    { name: '', device_type: 'multiDevice', created_at: null },
    { name: '', device_type: 'singleDevice', created_at: null },
  ] as never)
  expect(two).toMatch(/^They already have 2 passkeys: Synced passkey, Passkey on a device\./)
})

const person = (id: string, role: string, extra: Partial<AdminUser> = {}) =>
  ({
    id,
    name: `Person ${id}`,
    email: `${id}@example.com`,
    disabled_at: null,
    instance_admin: false,
    instance_admin_by_env: false,
    workspaces: [{ id: 'ws-1', name: 'Brightwater Plumbing', role, member_id: `m-${id}` }],
    invitations: [],
    ...extra,
  }) as unknown as AdminUser

test('Sign in as owner names the owner, asks for a reason and opens this workspace', async () => {
  const sent: { url: string; body: unknown }[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify({ ok: false, error: 'stop here' }), { status: 409 })
  })
  try {
    const users = [person('a', 'member'), person('o', 'owner')]
    const action = signInAsOwnerAction(workspace, users, 'me')!
    expect(action.label).toBe('Sign in as Person o…')
    expect(action.disabledReason).toBeUndefined()
    expect(action.confirm?.reason).toMatchObject({ min: 3, max: 300 })
    await expect(action.run(false, 'Ticket 1')).rejects.toThrow('stop here')
    expect(sent.at(-1)).toEqual({
      url: '/v1/impersonation/start',
      body: { userId: 'o', reason: 'Ticket 1', workspaceId: 'ws-1' },
    })
  } finally {
    vi.unstubAllGlobals()
  }
})

test('Sign in as owner: no owner, no button; yourself, disabled or a server admin, a disabled button with the reason', () => {
  expect(signInAsOwnerAction(workspace, [person('a', 'admin')], 'me')).toBeNull()
  expect(signInAsOwnerAction(workspace, [person('me', 'owner')], 'me')?.disabledReason).toMatch(/You are the owner/)
  expect(
    signInAsOwnerAction(workspace, [person('o', 'owner', { disabled_at: '2026-11-01T00:00:00Z' })], 'me')
      ?.disabledReason,
  ).toBe('Person o is disabled: enable the account first to sign in as them.')
  expect(
    signInAsOwnerAction(workspace, [person('o', 'owner', { instance_admin: true })], 'me')?.disabledReason,
  ).toMatch(/server admin/)
})

test('Sign in as … on a user asks for a reason too', () => {
  const action = userActions(person('u', 'member'), 'me', async () => {}).find(a => a.id === 'impersonate')!
  expect(action.confirm?.reason).toBeDefined()
})
