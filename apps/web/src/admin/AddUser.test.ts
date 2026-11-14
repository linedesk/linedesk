import { describe, expect, test } from 'vitest'
import { addedText, matchWorkspaces } from './AddUser.tsx'
import { addedNote } from './Memberships.tsx'
import type { AdminWorkspace } from './api.ts'
import { workspacesText } from './UsersPage.tsx'

const ws = { id: 'w1', name: 'Brightwater Plumbing & Heating', role: 'member' as const }

describe('Add user', () => {
  test('the toast says what happened', () => {
    expect(addedText({ email: 'a@x.test', existing: true, workspace: { ...ws, joined: 'added' } })).toBe(
      'Already has an account; added to Brightwater Plumbing & Heating.',
    )
    expect(
      addedText({ email: 'a@x.test', existing: true, delivery: 'smtp', workspace: { ...ws, joined: 'invited' } }),
    ).toBe(
      'Already has an account; invited to Brightwater Plumbing & Heating. They join once they confirm their address.',
    )
    expect(
      addedText({ email: 'a@x.test', existing: false, delivery: 'smtp', workspace: { ...ws, joined: 'invited' } }),
    ).toBe('Added a@x.test to Brightwater Plumbing & Heating. They get an email to sign in and join.')
    expect(addedText({ email: 'a@x.test', existing: false, delivery: 'log', workspace: null })).toBe(
      'Added a@x.test as server admin. Their email is in the server log.',
    )
  })

  test('many workspaces are searched by name', () => {
    const list = ['Zeta Roofing', 'Alder Electric', 'Brightwater Plumbing'].map(
      (name, i) => ({ id: `w${i}`, name }) as AdminWorkspace,
    )
    expect(matchWorkspaces(list, '').map(w => w.name)).toEqual([
      'Alder Electric',
      'Brightwater Plumbing',
      'Zeta Roofing',
    ])
    expect(matchWorkspaces(list, 'ROOF').map(w => w.name)).toEqual(['Zeta Roofing'])
    expect(matchWorkspaces(list, '', 2)).toHaveLength(2)
  })
})

describe('Add to workspace', () => {
  test('an unconfirmed address is invited, a confirmed one added', () => {
    expect(addedNote('Ana', 'Harbor Lane', { joined: 'added' })).toBe('Ana was added to Harbor Lane.')
    expect(addedNote('Ana', 'Harbor Lane', { joined: 'invited' })).toBe(
      'Ana was invited to Harbor Lane. They join once they confirm their email address.',
    )
  })
})

describe('Users list', () => {
  const invite = { id: 'i1', workspace_id: 'w1', workspace_name: 'Harbor Lane', role: 'member', expires_at: '' }
  test('without a workspace: where they are invited, else No workspace, muted', () => {
    expect(
      workspacesText({ workspaces: [{ id: 'w', name: 'A', role: 'owner', member_id: 'm' }], invitations: [] }),
    ).toEqual({
      text: 'A',
      muted: false,
    })
    expect(workspacesText({ workspaces: [], invitations: [invite] })).toEqual({
      text: 'Invited to Harbor Lane',
      muted: true,
    })
    expect(workspacesText({ workspaces: [], invitations: [] })).toEqual({ text: 'No workspace', muted: true })
  })
})
