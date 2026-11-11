import { describe, expect, it } from 'vitest'
import { tabNotice } from './TabWorkspaceNotice.tsx'

const bravo = { id: 'ws_b', name: 'Bravo HVAC' }
const alpha = { id: 'ws_a', name: 'Alpha Plumbing' }

describe('the notice of a tab whose workspace is not the session’s', () => {
  it('names the tab’s workspace and the one the session switched to, with Switch back', () => {
    expect(tabNotice({ code: 'workspace_switched', activeWorkspaceId: alpha.id }, bravo, [alpha, bravo])).toEqual({
      title: 'This tab is on Bravo HVAC',
      text: 'You switched to Alpha Plumbing in another tab. This tab sends nothing until you choose; changes made here are kept.',
      switchBack: 'Switch back to Bravo HVAC',
      reload: 'Open Alpha Plumbing',
    })
  })

  it('a workspace this tab does not know by name (just created or joined) is "another workspace"', () => {
    const notice = tabNotice({ code: 'workspace_switched', activeWorkspaceId: 'ws_new' }, bravo, [bravo])
    expect(notice.text).toContain('You switched to another workspace')
    expect(notice.reload).toBe('Reload')
  })

  it('lost access: no Switch back, only Reload', () => {
    expect(tabNotice({ code: 'workspace_access_lost' }, bravo, [alpha, bravo])).toMatchObject({
      title: 'You no longer have access to Bravo HVAC',
      switchBack: null,
      reload: 'Reload',
    })
  })

  it('someone else signed in on this browser: Reload', () => {
    expect(tabNotice({ code: 'account_switched' }, bravo, [alpha, bravo])).toMatchObject({
      title: 'Someone else signed in',
      switchBack: null,
      reload: 'Reload',
    })
  })

  it('a page older than the server: Linedesk was updated, Reload', () => {
    expect(tabNotice({ code: 'client_outdated' }, bravo, [alpha, bravo])).toMatchObject({
      title: 'Linedesk was updated',
      switchBack: null,
      reload: 'Reload',
    })
  })
})
