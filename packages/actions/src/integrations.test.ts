import { expect, test } from 'vitest'
import { zapierCanReach } from './integrations.ts'

test('Zapier reaches an https address on the internet, never http, localhost or a private address', () => {
  expect(zapierCanReach('https://app.linedesk.ai')).toBe(true)
  expect(zapierCanReach('https://linedesk.example.com:8443')).toBe(true)
  for (const origin of [
    'http://linedesk.example.com',
    'https://localhost:5173',
    'http://localhost:8490',
    'https://linedesk.localhost',
    'https://box.local',
    'https://127.0.0.1',
    'https://10.0.0.4',
    'https://192.168.1.20',
    'https://172.20.0.1',
    'https://[::1]',
    'not a url',
  ])
    expect(zapierCanReach(origin), origin).toBe(false)
})
