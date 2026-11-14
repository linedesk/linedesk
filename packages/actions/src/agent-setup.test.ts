// The agent setup page's start plan (agent-setup.ts): one command or link where the agent connects itself, a
// connector step only for the cloud chat apps, and the setup key never in a link to a website.
import { describe, expect, test } from 'vitest'
import {
  agentClients,
  agentSetupAllowHash,
  agentSetupPrompt,
  allowKeyIdOf,
  installPlace,
  isAgentSetupHash,
  reachableFromCloud,
  SETUP_MCP_INSTRUCTIONS,
  setupStepNames,
  shellQuote,
  startPlan,
  stepsByGroup,
} from './agent-setup.ts'

const URL = 'https://desk.example.com/mcp/setup/lds_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'

describe('startPlan', () => {
  test('Claude Code and Codex start with one command that connects the setup server', () => {
    const claude = startPlan('claude_code', URL).steps[0]!.code!
    expect(claude).toMatch(/^claude '[^']+' --mcp-config '/)
    expect(claude).toContain(JSON.stringify({ mcpServers: { 'linedesk-setup': { type: 'http', url: URL } } }))
    const codex = startPlan('codex', URL)
    expect(codex.steps).toHaveLength(1)
    expect(codex.steps[0]!.code).toContain(`-c 'mcp_servers.linedesk-setup.url="${URL}"'`)
  })

  test('Gemini CLI: one command adds the setup server for the user and starts the setup interactively', () => {
    const gemini = startPlan('gemini', URL)
    expect(gemini.steps[0]!.code).toMatch(
      /^gemini mcp add --scope user --transport http linedesk-setup '[^']+' && gemini -i '[^']+'$/,
    )
    expect(gemini.steps[0]!.code).toContain(`'${URL}'`)
    expect(gemini.steps[0]!.code).toContain('setup_status')
    expect(gemini.steps.some(s => s.code === URL && s.text.includes('Gemini in the browser'))).toBe(true)
  })

  test('GitHub Copilot: add the setup server in VS Code (MCP: Add Server, HTTP), then the chat link', () => {
    const { steps } = startPlan('copilot', URL)
    expect(steps[0]!.text).toContain('MCP: Add Server')
    expect(steps[0]!.code).toBe(URL)
    expect(steps[1]!.link!.href).toMatch(/^vscode:\/\/GitHub\.Copilot-Chat\/chat\?prompt=/)
  })

  test('links open the local apps with the whole prompt, which carries the setup server', () => {
    for (const client of ['claude_code', 'cursor', 'copilot'] as const) {
      const { steps, prompt } = startPlan(client, URL)
      const href = steps.find(s => s.link)!.link!.href
      expect(href).toMatch(/^(claude|cursor|vscode):\/\//)
      expect(decodeURIComponent(href.split(/[?&](?:q|text|prompt)=/)[1]!)).toBe(prompt)
      expect(prompt).toContain(URL)
    }
  })

  test('the cloud chat apps connect a connector first; their prompt and link carry no key', () => {
    for (const client of ['claude', 'chatgpt'] as const) {
      const { steps, prompt } = startPlan(client, URL)
      expect(steps.some(s => s.code === URL)).toBe(true)
      expect(prompt).not.toContain('lds_')
      for (const step of steps) expect(step.link?.href ?? '').not.toContain('lds_')
    }
  })

  test('every client has a prompt to paste', () => {
    for (const client of agentClients) expect(startPlan(client, URL).prompt.length).toBeGreaterThan(500)
  })
})

test('shellQuote: one shell word, single quotes kept', () => {
  expect(shellQuote("it's")).toBe(`'it'\\''s'`)
})

describe('installPlace', () => {
  test('this computer: localhost names and private networks, with or without https', () => {
    for (const url of [
      'http://localhost',
      'http://review.localhost:5240',
      'https://desk.local',
      'http://192.168.1.20',
      'http://10.0.0.5:8080',
      'http://172.20.0.1',
      'http://127.0.0.1:3100',
      'not a url',
    ])
      expect(installPlace(url), url).toBe('this_computer')
  })

  test('a public name or IP: public with https, no_https without; only public is reachable from the cloud', () => {
    expect(installPlace('https://desk.example.com')).toBe('public')
    expect(installPlace('https://203-0-113-7.sslip.io')).toBe('public')
    expect(installPlace('http://203.0.113.7')).toBe('no_https')
    expect(installPlace('http://desk.example.com')).toBe('no_https')
    expect(reachableFromCloud('https://desk.example.com')).toBe(true)
    expect(reachableFromCloud('http://desk.example.com')).toBe(false)
    expect(reachableFromCloud('https://review.localhost')).toBe(false)
  })
})

test('the setup page address with ?allow= names the one key to allow', () => {
  expect(agentSetupAllowHash('sk_abc123')).toBe('#setup-agent?allow=sk_abc123')
  expect(allowKeyIdOf(agentSetupAllowHash('sk_abc123'))).toBe('sk_abc123')
  expect(allowKeyIdOf('#setup-agent')).toBeNull()
  expect(allowKeyIdOf('#setup-agent?allow=')).toBeNull()
  expect(allowKeyIdOf('#admin?allow=sk_abc123')).toBeNull()
  expect(isAgentSetupHash('#setup-agent')).toBe(true)
  expect(isAgentSetupHash('#setup-agent?allow=sk_abc123')).toBe(true)
  expect(isAgentSetupHash('#setup-agents')).toBe(false)
  expect(isAgentSetupHash('#setup-install')).toBe(false)
})

describe('stepsByGroup', () => {
  test('the steps by part of the setup, in its order, leaving out a part without steps', () => {
    const step = (id: string, group: 'you' | 'server' | 'business') => ({ id, group })
    const steps = [step('answering', 'server'), step('workspace', 'business'), step('email', 'server')]
    expect(stepsByGroup(steps).map(g => [g.label, g.steps.map(s => s.id)])).toEqual([
      ['This server', ['answering', 'email']],
      ['Your business', ['workspace']],
    ])
    expect(stepsByGroup([step('phone', 'business'), step('passkey', 'you')]).map(g => [g.id, g.label])).toEqual([
      ['you', 'Security'],
      ['business', 'Your business'],
    ])
  })
})

describe('setup step names', () => {
  test('each step is named as its place in the app, the setup_status order words match', () => {
    expect(setupStepNames.notify?.label).toBe('Notifications')
    expect(setupStepNames['call-audio']?.hint).toMatch(/LiveKit.*SIP/)
    expect(SETUP_MCP_INSTRUCTIONS).toContain('when to answer, notifications, phone number')
    expect(SETUP_MCP_INSTRUCTIONS).not.toContain('who hears about calls')
  })

  test('the agent asks once about more businesses or locations; the first is set up now', () => {
    expect(agentSetupPrompt(URL)).toMatch(/more than one business or location/)
    expect(SETUP_MCP_INSTRUCTIONS).toMatch(/more than one business or location/)
  })
})
