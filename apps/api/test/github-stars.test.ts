// The GitHub star count next to Star on GitHub: read by the server about once an hour, kept on failure.
import { afterEach, expect, test, vi } from 'vitest'
import { fetchStarCount, refreshStarCount, resetStarCount, starCount } from '../src/github-stars.ts'

afterEach(() => resetStarCount())

const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }))

test('reads stargazers_count from the public repository; anything else is no count', async () => {
  const github = answer(200, { stargazers_count: 1234 })
  expect(await fetchStarCount('linedesk/linedesk', github as unknown as typeof fetch)).toBe(1234)
  expect(github).toHaveBeenCalledWith('https://api.github.com/repos/linedesk/linedesk', expect.anything())
  expect(await fetchStarCount('a/b', answer(403, { message: 'rate limit' }) as unknown as typeof fetch)).toBeNull()
  expect(await fetchStarCount('a/b', answer(200, { stargazers_count: '12' }) as unknown as typeof fetch)).toBeNull()
  const offline = async (): Promise<Response> => {
    throw new Error('offline')
  }
  expect(await fetchStarCount('a/b', offline)).toBeNull()
})

test('once an hour; a failure keeps the last count and tries again after ten minutes', async () => {
  const t0 = 1_000_000
  await refreshStarCount(t0, answer(200, { stargazers_count: 10 }) as unknown as typeof fetch)
  expect(starCount()).toBe(10)
  const later = answer(200, { stargazers_count: 11 })
  await refreshStarCount(t0 + 30 * 60_000, later as unknown as typeof fetch)
  expect(later).not.toHaveBeenCalled()
  await refreshStarCount(t0 + 61 * 60_000, answer(500, {}) as unknown as typeof fetch)
  expect(starCount()).toBe(10)
  await refreshStarCount(t0 + 65 * 60_000, later as unknown as typeof fetch)
  expect(later).not.toHaveBeenCalled()
  await refreshStarCount(t0 + 72 * 60_000, later as unknown as typeof fetch)
  expect(starCount()).toBe(11)
})
