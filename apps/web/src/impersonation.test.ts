import { describe, expect, test, vi } from 'vitest'
import { bannerText, confirmText, type Impersonation, minutesLeft, remainingText } from './impersonation.ts'

const imp: Impersonation = {
  by: { id: 'a', name: 'Mike Brennan', email: 'mike@linedesk.test' },
  user: { id: 'u', name: 'Mike Brennan', email: 'mike@brightwater.example' },
  expiresAt: '2026-11-11T12:00:00.000Z',
}

describe('impersonation banner', () => {
  test('says whose session it is and which admin is in it', () => {
    expect(bannerText(imp)).toEqual({
      who: 'Signed in as Mike Brennan',
      email: 'mike@brightwater.example',
      by: 'by Mike Brennan',
    })
    // Without a name the email names them already: it is not repeated.
    expect(bannerText({ ...imp, user: { ...imp.user, name: '' } })).toMatchObject({
      who: 'Signed in as mike@brightwater.example',
      email: null,
    })
  })

  test('remaining minutes round up and stop at zero', () => {
    expect(minutesLeft(imp.expiresAt, new Date('2026-11-11T11:00:00Z'))).toBe(60)
    expect(minutesLeft(imp.expiresAt, new Date('2026-11-11T11:59:01Z'))).toBe(1)
    expect(minutesLeft(imp.expiresAt, new Date('2026-11-11T12:00:30Z'))).toBe(0)
    expect([remainingText(60), remainingText(1), remainingText(0)]).toEqual([
      '60 minutes left',
      '1 minute left',
      'ending',
    ])
  })

  test('the confirmation says what happens and how long', () => {
    expect(confirmText('Mike Brennan')).toBe(
      'You will see Linedesk exactly as Mike Brennan does. Everything you do is recorded as done by you on their behalf. Ends after 1 hour.',
    )
  })
})

describe('switching the session', () => {
  test('no cached query loads while the switch is on its way; a refused switch lets them load again', async () => {
    const { fetchQuery } = await import('./cachedQuery.ts')
    const { whileSessionChanges } = await import('./impersonation.ts')
    const load = vi.fn(async () => 'answer')
    await expect(
      whileSessionChanges(async () => {
        await fetchQuery('notifications', load)
        throw new Error('Not possible while signed in as another user.')
      }),
    ).rejects.toThrow('Not possible')
    expect(load).not.toHaveBeenCalled()
    await fetchQuery('notifications', load)
    expect(load).toHaveBeenCalledTimes(1)
  })
})

describe('after the session switched', () => {
  test('the page reloads also when forgetting the local data fails, with the queries resumed', async () => {
    const { fetchQuery, holdQueries } = await import('./cachedQuery.ts')
    const { afterSessionChange } = await import('./impersonation.ts')
    const reload = vi.fn()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    holdQueries()
    await afterSessionChange(async () => {
      throw new Error('IndexedDB is blocked')
    }, reload)
    expect(reload).toHaveBeenCalledTimes(1)
    const load = vi.fn(async () => 'answer')
    await fetchQuery('team-after-switch', load)
    expect(load).toHaveBeenCalledTimes(1)

    const ok = vi.fn()
    await afterSessionChange(async () => {}, ok)
    expect(ok).toHaveBeenCalledTimes(1)
  })
})
