import { describe, expect, it } from 'vitest'
import { tabNotice } from './TabWorkspaceNotice.tsx'

const bravo = { id: 'ws_b', name: 'Bravo HVAC' }
const alpha = { id: 'ws_a', name: 'Alpha Plumbing' }

describe('the notice of a tab whose workspace is not the session’s', () => {
  it('names the tab’s workspace and the one the session switched to, with Switch back', () => {
    expect(tabNotice({ code: 'workspace_switched', activeWorkspaceId: alpha.id }, bravo, [alpha, bravo])).toEqual({
      title: 'This tab is on Bravo HVAC',
      text: 'You switched to Alpha Plumbing in another tab. This tab sends nothing until you choose; changes made here are kept.',
      actions: [
        { label: 'Switch back to Bravo HVAC', kind: 'switch', workspaceId: bravo.id, keepPage: true },
        { label: 'Open Alpha Plumbing', kind: 'reload' },
      ],
    })
  })

  it('a workspace this tab does not know by name (just created or joined) is "another workspace"', () => {
    const notice = tabNotice({ code: 'workspace_switched', activeWorkspaceId: 'ws_new' }, bravo, [bravo])
    expect(notice.text).toContain('You switched to another workspace')
    expect(notice.actions[1]).toEqual({ label: 'Reload', kind: 'reload' })
  })
})

describe('signed out or no access any more', () => {
  it('signed out: Sign in, and how many changes were rolled back', () => {
    expect(tabNotice({ code: 'signed_out' }, bravo, [bravo], 2)).toEqual({
      title: 'You were signed out',
      text: 'Sign in again to keep working. Your last 2 changes were not saved.',
      actions: [{ label: 'Sign in', kind: 'reload' }],
    })
    expect(tabNotice({ code: 'signed_out' }, bravo, [bravo], 1).text).toBe(
      'Sign in again to keep working. Your last change was not saved.',
    )
    expect(tabNotice({ code: 'signed_out' }, bravo, [bravo]).text).toBe('Sign in again to keep working.')
  })

  it('lost access: switch to another workspace of theirs, or sign out', () => {
    expect(tabNotice({ code: 'workspace_access_lost' }, bravo, [alpha, bravo], 1)).toEqual({
      title: 'You no longer have access to Bravo HVAC',
      text: 'You were removed from this workspace, or it no longer exists. Your last change was not saved.',
      actions: [
        { label: 'Switch to Alpha Plumbing', kind: 'switch', workspaceId: alpha.id, keepPage: false },
        { label: 'Sign out', kind: 'signOut' },
      ],
    })
  })

  it('lost access to the only workspace: Continue, or sign out', () => {
    expect(tabNotice({ code: 'workspace_access_lost' }, bravo, [bravo]).actions).toEqual([
      { label: 'Continue', kind: 'reload' },
      { label: 'Sign out', kind: 'signOut' },
    ])
  })

  it('someone else signed in on this browser: Reload', () => {
    expect(tabNotice({ code: 'account_switched' }, bravo, [alpha, bravo])).toMatchObject({
      title: 'Someone else signed in',
      actions: [{ label: 'Reload', kind: 'reload' }],
    })
  })

  it('a page older than the server: Linedesk was updated, Reload', () => {
    expect(tabNotice({ code: 'client_outdated' }, bravo, [alpha, bravo])).toMatchObject({
      title: 'Linedesk was updated',
      actions: [{ label: 'Reload', kind: 'reload' }],
    })
  })
})
