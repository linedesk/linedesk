// The agent container gets an explicit list of variables (docker-compose.yml), never the whole .env:
// the process that handles caller audio and LLM tool calls must not hold the install's secrets.
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { stageEnvVars } from './config.ts'

const compose = readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8')
/** The agent service's block: from `  agent:` to the next service at the same indent. */
const agentBlock = compose.slice(compose.indexOf('\n  agent:\n'), compose.indexOf('\n  livekit-egress:\n'))
const listed = new Set([...agentBlock.matchAll(/^ {6}([A-Z][A-Z0-9_]+):/gm)].map(m => m[1]))

test('the agent service reads no env_file', () => {
  expect(agentBlock).toContain('image: linedesk-agent')
  expect(agentBlock).not.toMatch(/env_file/)
})

test('no install secret reaches the agent', () => {
  const secrets = [
    'SECRETS_KEY',
    'BETTER_AUTH_SECRET',
    'DATABASE_URL',
    'POSTGRES_PASSWORD',
    'SMTP_URL',
    'TELNYX_API_KEY',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_ACCOUNT_SID',
    'VAPID_PRIVATE_KEY',
    'S3_SECRET_ACCESS_KEY',
    'ELECTRIC_SECRET',
  ]
  for (const name of secrets) expect(listed.has(name), name).toBe(false)
  expect(agentBlock).not.toMatch(/GOOGLE_CLIENT_SECRET|MICROSOFT_CLIENT_SECRET|GITHUB_CLIENT_SECRET|OIDC_CLIENT_SECRET/)
})

test('what the agent needs is listed: its token, LiveKit and every speech, model and voice variable', () => {
  for (const name of [
    'AGENT_API_TOKEN',
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
    'LIVEKIT_URL',
    'LINEDESK_API_URL',
    ...stageEnvVars,
  ]) {
    expect(listed.has(name), name).toBe(true)
  }
})
