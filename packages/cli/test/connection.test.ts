import { afterEach, describe, expect, it } from 'vitest'
import { main } from '../src/index.ts'

describe('the server address', () => {
  afterEach(() => {
    delete process.env.LINEDESK_URL
    delete process.env.LINEDESK_API_KEY
  })
  it('refuses plain http to another machine, also from LINEDESK_URL', async () => {
    process.env.LINEDESK_URL = 'http://linedesk.example.com'
    process.env.LINEDESK_API_KEY = 'ldp_test'
    const err: string[] = []
    const code = await main(['whoami'], { out: () => {}, err: t => err.push(t) })
    expect(code).toBe(1)
    expect(err.join('\n')).toContain('https://')
  })
})
