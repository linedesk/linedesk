import { agentClientLabels, agentClients } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { AgentPicker, CLAUDE_ORANGE, GEMINI_PURPLE } from './AgentPicker.tsx'

const options = (html: string) => html.split('<button').slice(1)

describe('AgentPicker', () => {
  const html = renderToStaticMarkup(<AgentPicker client="codex" onPick={() => {}} />)

  test('every agent gets one option with its mark, hidden from screen readers, and its name as the label', () => {
    const buttons = options(html)
    expect(buttons).toHaveLength(agentClients.length)
    agentClients.forEach((id, i) => {
      const button = buttons[i]!
      expect(button.match(/<svg/g)).toHaveLength(1)
      expect(button).toMatch(
        /<svg class="(k-icon )?as-agent-mark[^"]*"[^>]* width="16" height="16"[^>]*aria-hidden="true"/,
      )
      expect(button).toContain(`</svg>${agentClientLabels[id]}</button>`)
    })
  })

  test('Claude and Claude Code in Claude orange, Gemini in its purple, the OpenAI, Copilot and Cursor marks in the text colour, Other muted', () => {
    const mark = (id: (typeof agentClients)[number]) => options(html)[agentClients.indexOf(id)]!
    for (const id of ['claude_code', 'claude'] as const) expect(mark(id)).toContain(`fill="${CLAUDE_ORANGE}"`)
    expect(mark('gemini')).toContain(`fill="${GEMINI_PURPLE}"`)
    for (const id of ['chatgpt', 'codex', 'copilot', 'cursor'] as const)
      expect(mark(id)).toContain('fill="currentColor"')
    const path = (id: (typeof agentClients)[number]) => mark(id).match(/ d="([^"]+)"/)![1]
    expect(path('chatgpt')).toBe(path('codex'))
    expect(
      new Set(['claude', 'codex', 'copilot', 'gemini', 'cursor'].map(id => path(id as (typeof agentClients)[number])))
        .size,
    ).toBe(5)
    expect(mark('other')).toContain('as-agent-mark is-muted')
  })

  test('GitHub Copilot and Gemini come after Codex, before Cursor; Other stays last', () => {
    expect(agentClients.slice(3)).toEqual(['codex', 'copilot', 'gemini', 'cursor', 'other'])
    expect(agentClientLabels.copilot).toBe('GitHub Copilot')
    expect(agentClientLabels.gemini).toBe('Gemini')
  })

  test('the chosen agent is checked', () => {
    const buttons = options(html)
    expect(buttons.filter(b => b.includes('aria-checked="true"'))).toHaveLength(1)
    expect(buttons[agentClients.indexOf('codex')]).toContain('aria-checked="true"')
  })
})
