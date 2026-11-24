import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { Field } from '../settings/fields.tsx'
import { Card } from './form.tsx'
import {
  copyText,
  HelpBody,
  HelpTip,
  type HelpTipEvent,
  type HelpTipState,
  helpContent,
  helpTipReducer,
} from './HelpTip.tsx'

const closed: HelpTipState = { open: false, pinned: false }
const run = (...events: HelpTipEvent[]) => events.reduce(helpTipReducer, closed)

describe('opening and closing', () => {
  test('hover opens it and leaving closes it', () => {
    expect(run('hover')).toEqual({ open: true, pinned: false })
    expect(run('hover', 'leave')).toEqual(closed)
  })

  test('a click or tap opens it and keeps it open when the pointer leaves; another click closes it', () => {
    expect(run('click')).toEqual({ open: true, pinned: true })
    expect(run('click', 'leave')).toEqual({ open: true, pinned: true })
    expect(run('click', 'click')).toEqual(closed)
  })

  test('a click while hover has it open keeps it open', () => {
    expect(run('hover', 'click', 'leave')).toEqual({ open: true, pinned: true })
  })

  test('keyboard focus opens it, and focus leaving closes it, pinned or not', () => {
    expect(run('focus')).toEqual({ open: true, pinned: false })
    expect(run('focus', 'blur')).toEqual(closed)
    expect(run('focus', 'click', 'blur')).toEqual(closed)
  })

  test('Enter or Space on the focused "?" (a click) keeps it open; again closes it', () => {
    expect(run('focus', 'click')).toEqual({ open: true, pinned: true })
    expect(run('focus', 'click', 'click')).toEqual(closed)
  })

  test('Esc and a click outside close it, also when pinned', () => {
    for (const end of ['escape', 'outside'] as const) {
      expect(run('hover', end)).toEqual(closed)
      expect(run('click', end)).toEqual(closed)
    }
  })

  test('events while closed leave it closed (the same state, so nothing renders again)', () => {
    expect(helpTipReducer(closed, 'escape')).toBe(closed)
    expect(helpTipReducer(closed, 'blur')).toBe(closed)
    const open = run('hover')
    expect(helpTipReducer(open, 'focus')).toBe(open)
  })
})

describe('copy', () => {
  test('copies the command and says so', async () => {
    const copied: string[] = []
    const clipboard = { writeText: async (text: string) => void copied.push(text) }
    expect(await copyText('docker compose logs api', clipboard)).toBe('copied')
    expect(copied).toEqual(['docker compose logs api'])
  })

  test('without clipboard access it says it failed, so the user selects it instead', async () => {
    const denied = {
      writeText: async () => {
        throw new Error('denied')
      },
    }
    expect(await copyText('x', denied)).toBe('failed')
    expect(await copyText('x', undefined)).toBe('failed')
  })
})

describe('markup', () => {
  test('closed: a labelled "?" button that says it is collapsed, nothing else on the page', () => {
    const html = renderToStaticMarkup(<HelpTip label="Where is the setup code?" text="Hidden until asked." />)
    expect(html).toContain('type="button"')
    expect(html).toContain('aria-label="Where is the setup code?"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Hidden until asked.')
  })

  test('in a field it carries the in-field class', () => {
    expect(renderToStaticMarkup(<HelpTip inField text="x" />)).toContain('k-help is-in-field')
  })

  test('the open help: title, words, each command with its own Copy button, a last line and the docs link', () => {
    const html = renderToStaticMarkup(
      <HelpBody
        title="Setup code"
        text="Printed at start."
        commands={[{ label: 'On the server', code: 'docker compose logs api' }, { code: 'cat setup.txt' }]}
        after="Or ask an admin."
        learnMore="https://example.com/docs"
      />,
    )
    expect(html).toContain('Setup code')
    expect(html).toContain('Printed at start.')
    expect(html).toContain('On the server')
    expect(html).toContain('<code>docker compose logs api</code>')
    expect(html).toContain('aria-label="Copy docker compose logs api"')
    expect(html).toContain('aria-label="Copy cat setup.txt"')
    expect(html).toContain('Or ask an admin.')
    expect(html).toContain('href="https://example.com/docs"')
    expect(html).toContain('rel="noreferrer"')
  })

  test('plain words become the text', () => {
    expect(helpContent('Short.')).toEqual({ text: 'Short.' })
    expect(helpContent({ text: 'x', commands: [{ code: 'y' }] })).toEqual({ text: 'x', commands: [{ code: 'y' }] })
  })
})

describe('in forms', () => {
  test('a field’s help is a "?" next to its label, not a line on the page; the line stays for what everyone needs', () => {
    const html = renderToStaticMarkup(
      <Field id="f" label="Time zone" help="Read only." tip="Where the business is.">
        <input id="f" />
      </Field>,
    )
    expect(html).toContain('class="k-help-btn"')
    expect(html).not.toContain('Where the business is.')
    expect(html).toContain('<p class="k-field-desc">Read only.</p>')
  })

  test('a card title takes the full help content too', () => {
    const html = renderToStaticMarkup(
      <Card title="Setup" help={{ text: 'Printed at start.', commands: [{ code: 'docker compose logs api' }] }} />,
    )
    expect(html).toMatch(/<h2[^>]*>Setup<span class="k-help">/)
  })
})

describe('alignment', () => {
  const css = readFileSync(new URL('./form.css', import.meta.url), 'utf8')
  const block = (selector: string) => {
    const start = css.indexOf(`\n${selector} {`)
    return css.slice(start, css.indexOf('}', start))
  }

  test('the "?" is one line of its parent tall, at the line’s top, with the circle centred in it', () => {
    const help = block('.k-help')
    expect(help).toContain('height: 1lh;')
    expect(help).toContain('vertical-align: top;')
    expect(help).toContain('align-items: center;')
  })

  test('the circle scales with the text it follows, never below 14px; the glyph is a share of it', () => {
    const btn = block('.k-help-btn')
    expect(btn).toContain('width: max(14px, 1.1em);')
    expect(btn).toContain('height: max(14px, 1.1em);')
    expect(btn).not.toMatch(/font-size:/)
    expect(renderToStaticMarkup(<HelpTip text="x" />)).toContain('<span class="k-help-q" aria-hidden="true">?</span>')
  })
})
