import { type AgentClient, agentClients, english } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { AgentSteps } from '../onboarding/AgentForm.tsx'
import { connectPlan } from './connectPlan.ts'

const ORIGIN = 'https://desk.example'
const plan = (client: AgentClient) => connectPlan(client, ORIGIN, 'Linedesk', english.t)
const render = (client: AgentClient) => renderToStaticMarkup(<AgentSteps plan={plan(client)} />)

describe('Settings › Integrations › MCP: the setup page picker and steps, with the MCP address and OAuth', () => {
  test('every agent has a way, none carries a prompt or a key', () => {
    for (const client of agentClients) {
      const p = plan(client)
      expect(p.open || p.steps.length > 0).toBeTruthy()
      expect(p.prompt).toBe('')
      expect(JSON.stringify(p)).not.toMatch(/lds_|Bearer/)
    }
  })

  test('agents with a terminal: one command to copy, the main action', () => {
    expect(render('claude_code')).toMatch(
      /<code>claude mcp add --transport http linedesk https:\/\/desk\.example\/mcp<\/code><button[^>]*k-btn-primary/,
    )
    expect(render('codex')).toContain('<code>codex mcp add linedesk --url https://desk.example/mcp</code>')
    expect(render('gemini')).toContain('<code>gemini mcp add --transport http linedesk https://desk.example/mcp</code>')
  })

  test('Cursor, VS Code and Claude: the install link first, the rest behind a closed "Or …"', () => {
    const cursor = render('cursor')
    expect(cursor).toMatch(
      /<a class="k-btn k-btn-primary k-btn-md" href="cursor:\/\/[^"]+" title="[^"]+">Add to Cursor<\/a>/,
    )
    expect(cursor).toContain('<details class="as-other-way"><summary>Or add it by hand</summary>')
    expect(render('copilot')).toMatch(/href="vscode:[^"]+"[^>]*>Add to VS Code</)
    expect(render('copilot')).toMatch(/href="vscode-insiders:[^"]+"[^>]*>Add to VS Code Insiders</)
    const claude = render('claude')
    expect(claude).toMatch(/k-btn-primary[^>]*href="https:\/\/claude\.ai[^"]+"[^>]*>Open in Claude</)
    expect(claude).toContain('<summary>Claude Team or Enterprise?</summary>')
  })

  test('ChatGPT: three numbered steps, its form drawn filled in with the address, OAuth picked', () => {
    const html = render('chatgpt')
    expect(html).toMatch(/<ol class="as-steps">/)
    expect(html.match(/class="as-step-number"/g)).toHaveLength(3)
    expect(html).toMatch(/href="https:\/\/chatgpt\.com\/plugins"[^>]*>Open ChatGPT plugins</)
    expect(html).toContain('<code title="https://desk.example/mcp">https://desk.example/mcp</code>')
    expect(html).toMatch(/as-form-pick[\s\S]*OAuth/)
    expect(html).toContain('Click Install on the new plugin')
  })

  test('Other: the address to add', () => {
    expect(render('other')).toContain('<code>https://desk.example/mcp</code>')
  })
})
