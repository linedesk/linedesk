import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { confirmErrorText, deleteWorkspaceText } from './actions.tsx'
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

test('deleting a workspace lists what goes and says it cannot be undone', () => {
  const text = deleteWorkspaceText(workspace)
  expect(text.after).toBe('This cannot be undone.')
  expect(text.list).toEqual([
    '12 calls, with their transcripts and recordings',
    '1 contact',
    '0 phone numbers',
    'Its bookings, settings and invitations',
    'The accounts of 1 member who belongs to no other workspace',
    'The access of 2 other members; their accounts and other workspaces stay',
  ])
})

test('a failed confirmation says why in one short sentence, never a raw error', () => {
  expect(confirmErrorText(new StepUpRequired('Confirm with your passkey to do this.', 'confirm'))).toBe(
    'Not confirmed with your passkey. Nothing changed.',
  )
  expect(confirmErrorText(new TypeError('Failed to fetch'))).toBe(
    "The server can't be reached. Check your connection and try again.",
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
