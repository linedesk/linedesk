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

// A further voice server (docker-compose.voice.yml) runs the same agent with the addresses of the voice links.
const voiceCompose = readFileSync(new URL('../../../docker-compose.voice.yml', import.meta.url), 'utf8')
const voiceAgentBlock = voiceCompose.slice(voiceCompose.indexOf('\n  agent:\n'), voiceCompose.indexOf('\nvolumes:\n'))
const voiceListed = new Set([...voiceAgentBlock.matchAll(/^ {6}([A-Z][A-Z0-9_]+):/gm)].map(m => m[1]))
/** Top-level keys of the agent service (restart, image, healthcheck, ...), without their values. */
const serviceKeys = (block: string) => new Set([...block.matchAll(/^ {4}([a-z_]+):/gm)].map(m => m[1]))

test('a voice server runs only the agent, without env_file', () => {
  expect([...voiceCompose.matchAll(/^ {2}([a-z-]+):$/gm)].map(m => m[1])).toEqual(['agent', 'greetings'])
  expect(voiceAgentBlock).toContain('image: linedesk-agent')
  expect(voiceAgentBlock).not.toMatch(/env_file/)
})

test("a voice server's agent gets exactly the variables of the main stack's agent", () => {
  expect([...voiceListed].sort()).toEqual([...listed].sort())
})

test("a voice server's agent keeps the main stack's agent settings (health check, drain, hardening)", () => {
  // restart and logging come from the main stack's `<<: *service`; depends_on names services only the main stack has.
  const voiceKeys = [...serviceKeys(voiceAgentBlock)].filter(k => k !== 'restart' && k !== 'logging')
  expect(voiceKeys.sort()).toEqual([...serviceKeys(agentBlock)].filter(k => k !== 'depends_on').sort())
  for (const line of ['security_opt: [no-new-privileges:true]', 'cap_drop: [ALL]'])
    expect(voiceAgentBlock).toContain(line)
  expect(voiceAgentBlock).toMatch(/stop_grace_period: \$\{LINEDESK_AGENT_DRAIN:-130m\}\n/)
  const healthcheck = (block: string) =>
    block.slice(block.indexOf('    healthcheck:'), block.indexOf('    stop_grace_period:'))
  expect(healthcheck(voiceAgentBlock).replace(/^ *#.*\n/gm, '')).toBe(healthcheck(agentBlock).replace(/^ *#.*\n/gm, ''))
})

test("a further voice server's agent reaches the API and LiveKit only through the voice links", () => {
  expect(voiceAgentBlock).toMatch(/LINEDESK_API_URL: http:\/\/\$\{LINEDESK_MAIN_HOST:\?[^}]*\}:3100\n/)
  expect(voiceAgentBlock).toMatch(/LIVEKIT_URL: ws:\/\/\$\{LINEDESK_LIVEKIT_HOST:\?[^}]*\}:7880\n/)
  // More than one worker: refusing when full is required, and so are the cores and memory of a dedicated server.
  for (const name of ['AGENT_LOAD_THRESHOLD', 'LINEDESK_VOICE_CPUSET', 'LINEDESK_AGENT_MEM'])
    expect(voiceAgentBlock).toMatch(new RegExp(`\\$\\{${name}:\\?`))
})

// The app server (docker-compose.voice-link.yml) and voice server 1 (docker-compose.voice-media.yml).
const appLink = readFileSync(new URL('../../../docker-compose.voice-link.yml', import.meta.url), 'utf8')
const media = readFileSync(new URL('../../../docker-compose.voice-media.yml', import.meta.url), 'utf8')
const published = (file: string) => [...file.matchAll(/^ {6}- "(.*)"$/gm)].map(m => m[1])
const site = (file: string, port: number) =>
  file.slice(file.indexOf(`        :${port} {`), file.indexOf('\n        }\n', file.indexOf(`        :${port} {`)))

test('the app server publishes only its voice link (the internal listener, on the private address)', () => {
  expect(published(appLink)).toHaveLength(1)
  expect(published(appLink)[0]).toMatch(/^\$\{LINEDESK_VOICE_LINK_IP:\?[^}]*\}:3100:3100$/)
  expect(site(appLink, 3100)).toContain('@agent path /v1/agent/* /v1/actions/*\n')
  expect(site(appLink, 3100)).toContain('header_up X-Linedesk-Voice-Node {remote_host}')
  expect(site(appLink, 3100)).toMatch(/handle @agent \{\n {12}reverse_proxy proxy:3100 /)
  expect(site(appLink, 3100)).toMatch(/handle \{\n {12}respond 404\n/)
})

test('the app server runs no call service: its livekit only forwards to voice server 1, without ports', () => {
  for (const name of ['livekit-sip', 'livekit-egress', 'recordings-init', 'redis', 'agent'])
    expect(appLink).toContain(`  ${name}:\n    profiles: !override [on-voice-server]\n`)
  const livekit = appLink.slice(appLink.indexOf('\n  livekit:\n'), appLink.indexOf('\n  livekit-sip:\n'))
  expect(livekit).toContain('    ports: !reset []\n')
  expect(livekit).toContain('reverse_proxy {$$LINEDESK_LIVEKIT_HOST}:7880 {')
  expect(livekit).toMatch(/LINEDESK_LIVEKIT_HOST: \$\{LINEDESK_LIVEKIT_HOST:\?/)
})

test("voice server 1 runs no app service and publishes only LiveKit's voice link, on the private address", () => {
  for (const name of ['postgres', 'electric', 'api', 'proxy', 'web'])
    expect(media).toContain(`  ${name}:\n    profiles: [on-app-server]\n`)
  expect(published(media)).toHaveLength(1)
  expect(published(media)[0]).toMatch(/^\$\{LINEDESK_VOICE_LINK_IP:\?[^}]*\}:7880:7880$/)
  expect(site(media, 7880)).toContain(
    '@livekit path /agent /rtc /rtc/* /twirp/livekit.RoomService/* /twirp/livekit.SIP/* /twirp/livekit.Egress/* /twirp/livekit.AgentDispatchService/*\n',
  )
  expect(site(media, 7880)).toMatch(/handle @livekit \{\n {12}reverse_proxy livekit:7880 /)
  expect(site(media, 7880)).toMatch(/handle \{\n {12}respond 404\n/)
  expect(media).toMatch(/LINEDESK_API_URL: http:\/\/\$\{LINEDESK_MAIN_HOST:\?[^}]*\}:3100\n/)
  expect(media).toMatch(/AGENT_LOAD_THRESHOLD: \$\{AGENT_LOAD_THRESHOLD:\?/)
})

test("voice server 1's LiveKit keys keep the main key and add the further voice servers' own", () => {
  expect(media).toContain(
    `LIVEKIT_KEYS: '{"\${LIVEKIT_API_KEY:?set LIVEKIT_API_KEY in .env (see .env.example)}": "\${LIVEKIT_API_SECRET:?set LIVEKIT_API_SECRET in .env (see .env.example)}"\${LINEDESK_VOICE_LIVEKIT_KEYS:+, \${LINEDESK_VOICE_LIVEKIT_KEYS}}}'`,
  )
})
