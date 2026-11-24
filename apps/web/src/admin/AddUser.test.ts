import { describe, expect, test } from 'vitest'
import { addedText, matchWorkspaces, roleChoices, workspacesWithOwner } from './AddUser.tsx'
import { addedNote } from './Memberships.tsx'
import { type AdminUser, type AdminWorkspace, filterUsers } from './api.ts'
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
    expect(
      addedText({ email: 'a@x.test', existing: false, delivery: 'log', workspace: { ...ws, joined: 'invited' } }),
    ).toBe('Added a@x.test to Brightwater Plumbing & Heating. Their email is in the server log.')
    expect(addedText({ email: 'a@x.test', existing: false, delivery: 'smtp', workspace: null })).toBe(
      'Added a@x.test as server admin. They get an email to sign in.',
    )
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

describe('Add user: Owner only where the workspace has none (A16)', () => {
  test('a workspace with an owner, or an owner invitation pending, has one', () => {
    const owned = workspacesWithOwner([
      { workspaces: [{ id: 'w1', name: 'Brightwater', role: 'owner', member_id: 'm1' }], invitations: [] },
      { workspaces: [{ id: 'w2', name: 'Harbor Lane', role: 'admin', member_id: 'm2' }], invitations: [] },
      {
        workspaces: [],
        invitations: [
          { id: 'i1', workspace_id: 'w3', workspace_name: 'Alder Electric', role: 'owner', expires_at: '' },
        ],
      },
    ])
    expect([...owned].sort()).toEqual(['w1', 'w3'])
  })

  test('Owner is shown off with why, the other roles stay', () => {
    const owner = (hasOwner: boolean) => roleChoices(hasOwner).find(o => o.value === 'owner')
    expect(owner(true)).toMatchObject({ disabled: true, description: 'Has an owner' })
    expect(owner(false)).not.toHaveProperty('disabled')
    expect(
      roleChoices(true)
        .filter(o => !('disabled' in o))
        .map(o => o.value),
    ).toEqual(['admin', 'member'])
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
    expect(
      workspacesText({
        workspaces: [],
        invitations: [invite, { ...invite, id: 'i2', workspace_name: 'Alder Electric' }],
      }),
    ).toEqual({ text: 'Invited to Harbor Lane, Alder Electric', muted: true })
  })
})

test('Users › No workspace: accounts without a membership, invited ones included (A9)', () => {
  const user = (id: string, workspaces: AdminUser['workspaces'], invited = false) =>
    ({
      id,
      workspaces,
      invitations: invited
        ? [{ id: 'i1', workspace_id: 'w1', workspace_name: 'Shop', role: 'member', expires_at: '' }]
        : [],
    }) as unknown as AdminUser
  const users = [
    user('in', [{ id: 'w1', name: 'Shop', role: 'member', member_id: 'm1' }]),
    user('none', []),
    user('invited', [], true),
  ]
  expect(filterUsers(users, 'noWorkspace').map(u => u.id)).toEqual(['none', 'invited'])
  expect(filterUsers(users, 'all').map(u => u.id)).toEqual(['in', 'none', 'invited'])
})
