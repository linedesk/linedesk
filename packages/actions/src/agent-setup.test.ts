// The agent setup page's start plan (agent-setup.ts): one command or link where the agent connects itself, a
// connector step only for the cloud chat apps, and the setup key never in a link to a website.
import { describe, expect, test } from 'vitest'
import { agentClients, shellQuote, startPlan } from './agent-setup.ts'

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

  test('links open the local apps with the whole prompt, which carries the setup server', () => {
    for (const client of ['claude_code', 'cursor'] as const) {
      const { steps, prompt } = startPlan(client, URL)
      const href = steps.find(s => s.link)!.link!.href
      expect(href).toMatch(/^(claude|cursor):\/\//)
      expect(decodeURIComponent(href.split(/[?&](?:q|text)=/)[1]!)).toBe(prompt)
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
