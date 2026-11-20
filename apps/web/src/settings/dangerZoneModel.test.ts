import type { WorkspaceDeletePreviewData } from '@linedesk/actions'
import { expect, test } from 'vitest'
import { deleteOwnConfirmation, deleteOwnList, ownAccountWarning } from './dangerZoneModel.ts'

const preview: WorkspaceDeletePreviewData = {
  name: 'Zz Delete Test',
  calls: 12,
  contacts: 1,
  numbers: { bought: 1, attached: 2 },
  otherMembers: 3,
  accountsDeleted: 2,
  ownAccountDeleted: true,
  planEnds: false,
  stepUp: null,
}

test('the dialog lists the counts, what happens to the numbers and the accounts that go', () => {
  expect(deleteOwnList(preview, 'Linedesk')).toEqual([
    '12 calls, with their transcripts and recordings',
    '1 contact',
    '1 phone number bought through Linedesk: released at the carrier',
    '2 phone numbers you brought or connected: they stop reaching Linedesk and stay yours',
    'Its bookings, settings and invitations',
    'The access of 3 other members; each of them gets an email that it was deleted',
    '2 accounts will be deleted because they have no other workspace',
  ])
})

test('one of each, and nothing to say about members or numbers when there are none', () => {
  expect(
    deleteOwnList(
      { ...preview, calls: 1, numbers: { bought: 0, attached: 1 }, otherMembers: 1, accountsDeleted: 1 },
      'Linedesk',
    ),
  ).toEqual([
    '1 call, with their transcripts and recordings',
    '1 contact',
    '1 phone number you brought or connected: it stops reaching Linedesk and stays yours',
    'Its bookings, settings and invitations',
    'The access of 1 other member; each of them gets an email that it was deleted',
    '1 account will be deleted because it has no other workspace',
  ])
  expect(
    deleteOwnList({ ...preview, numbers: { bought: 0, attached: 0 }, otherMembers: 0, accountsDeleted: 0 }, 'Linedesk'),
  ).toEqual([
    '12 calls, with their transcripts and recordings',
    '1 contact',
    '0 phone numbers',
    'Its bookings, settings and invitations',
  ])
})

test('the name is typed to confirm; a keep box (off: the accounts are deleted) only when an account would go', () => {
  const confirm = deleteOwnConfirmation(preview, 'Linedesk')
  expect(confirm).toMatchObject({
    typed: 'Zz Delete Test',
    action: 'Delete workspace',
    option: 'Keep these accounts, yours included',
  })
  expect(confirm.after).toBe('This cannot be undone.')
  expect(deleteOwnConfirmation({ ...preview, ownAccountDeleted: false }, 'Linedesk').option).toBe('Keep their accounts')
  expect(deleteOwnConfirmation({ ...preview, accountsDeleted: 0 }, 'Linedesk').option).toBe('Keep my account')
  expect(
    deleteOwnConfirmation({ ...preview, accountsDeleted: 0, ownAccountDeleted: false }, 'Linedesk').option,
  ).toBeUndefined()
})

test('a separate danger warning for the own account, gone quiet once it is kept', () => {
  expect(ownAccountWarning(preview, false)).toMatchObject({
    tone: 'danger',
    title: 'Your own account will be deleted too.',
  })
  expect(ownAccountWarning(preview, false)?.text).toMatch(/signed out and can't sign in again/)
  expect(ownAccountWarning(preview, true)).toMatchObject({ tone: 'neutral', title: 'Your account stays.' })
  expect(ownAccountWarning({ ownAccountDeleted: false }, false)).toBeNull()
})

test('a workspace that alone pays for a running plan says the plan ends with it (LIN-647)', () => {
  expect(deleteOwnList({ ...preview, planEnds: true }, 'Linedesk').at(-1)).toBe(
    'Its plan, which ends now: nothing more is charged, and the rest of the period is not refunded',
  )
})
