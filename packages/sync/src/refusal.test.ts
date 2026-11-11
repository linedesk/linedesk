import { describe, expect, it } from 'vitest'
import { keepsPendingWrites, refusalOf } from './refusal.ts'

describe('what an answer stands for', () => {
  it('a 401 is "signed out" only when it is the API’s own (a proxy’s 401 is not)', () => {
    expect(refusalOf(401, { ok: false, code: 'signed_out' })).toEqual({ code: 'signed_out' })
    expect(refusalOf(401, { ok: false, code: 'no_workspace' })).toEqual({ code: 'signed_out' })
    expect(refusalOf(401, { error: 'Unauthorized' })).toBeNull()
    expect(refusalOf(401, null)).toBeNull()
  })

  it('a 403 is a refusal only when it names one; a missing permission is a rejection of the command', () => {
    expect(refusalOf(403, { code: 'workspace_access_lost' })).toEqual({ code: 'workspace_access_lost' })
    expect(refusalOf(403, { code: 'workspace_switched', activeWorkspaceId: 'ws_b' })).toEqual({
      code: 'workspace_switched',
      activeWorkspaceId: 'ws_b',
    })
    expect(refusalOf(403, { code: 'client_outdated' })).toEqual({ code: 'client_outdated' })
    expect(refusalOf(403, { code: 'account_switched' })).toEqual({ code: 'account_switched' })
    expect(refusalOf(403, { error: 'missing permission settings:write' })).toBeNull()
    expect(refusalOf(409, { code: 'workspace_switched' })).toBeNull()
  })

  it('unsent changes are kept where the same person can still send them, rolled back otherwise', () => {
    expect(keepsPendingWrites({ code: 'workspace_switched' })).toBe(true)
    expect(keepsPendingWrites({ code: 'client_outdated' })).toBe(true)
    expect(keepsPendingWrites({ code: 'account_switched' })).toBe(true)
    expect(keepsPendingWrites({ code: 'signed_out' })).toBe(false)
    expect(keepsPendingWrites({ code: 'workspace_access_lost' })).toBe(false)
  })
})
