import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { contactsEmptyCopy } from '../contacts/model.ts'
import { InboxEmpty } from '../inbox/InboxEmpty.tsx'
import { PageTitle, SearchButton, SearchField, ShortcutHints, ZeroState } from './listPage.tsx'

const noop = () => {}

describe('list page frame', () => {
  test('the title is the page heading, with its count', () => {
    expect(renderToStaticMarkup(<PageTitle title="Contacts" count={9} />)).toBe(
      '<h1 class="ib-mode ib-title"><b>Contacts</b><span class="n">9</span></h1>',
    )
    // Nothing yet: the title stays, without a 0.
    expect(renderToStaticMarkup(<PageTitle title="Contacts" count={0} />)).toBe(
      '<h1 class="ib-mode ib-title"><b>Contacts</b></h1>',
    )
  })

  test('Search is the quiet button with its / key, as on the inbox', () => {
    const html = renderToStaticMarkup(<SearchButton label="Search contacts" onClick={noop} />)
    expect(html).toContain('k-btn-ghost')
    expect(html).toContain('title="Search contacts (/)"')
    expect(html).toContain('<span>Search</span>')
    expect(html).toContain('/</kbd>')
  })

  test('the search field fills the bar and closes with Close (esc)', () => {
    const html = renderToStaticMarkup(
      <SearchField id="s" value="sa" placeholder="Search" label="Search contacts" onChange={noop} onClose={noop} />,
    )
    expect(html).toMatch(/^<div class="ib-search"><svg/)
    expect(html).toContain('id="s"')
    expect(html).toContain('aria-label="Search contacts"')
    expect(html).toContain('title="Close search (esc)"')
  })

  test('the hints start with J K move', () => {
    const html = renderToStaticMarkup(<ShortcutHints hints={[[['⏎'], 'open']]} />)
    expect(html).toMatch(/^<div class="ib-hint"><span>.*J.*K.*move<\/span><span>.*⏎.*open<\/span><\/div>$/)
  })

  test('an empty list leaves J K move out (C6)', () => {
    const html = renderToStaticMarkup(<ShortcutHints move={false} hints={[[['tab'], 'switch']]} />)
    expect(html).not.toContain('move')
    expect(html).toContain('switch')
  })

  test('the inbox and contacts share one empty state', () => {
    const inbox = renderToStaticMarkup(
      <InboxEmpty tab="you" search={null} assistant="Maya" handledCount={0} hasAnyCalls={false} />,
    )
    const contacts = renderToStaticMarkup(<ZeroState {...contactsEmptyCopy('')} />)
    // The same picture, with the page's own mark in the sun: a check for calls, a person for contacts.
    const frame = (html: string) =>
      html.replace(/<h2>.*$/, '').replace(/<path d="[^"]*" class="zero-mark [^"]*"><\/path>/, '')
    expect(frame(contacts)).toBe(frame(inbox))
    expect(inbox).toContain('class="zero-mark zero-check"')
    expect(inbox).not.toContain('zero-contact')
    expect(contacts).toContain('class="zero-mark zero-contact"')
    expect(contacts).not.toContain('zero-check')
    expect(contacts).toContain('<h2>No contacts yet</h2>')
    expect(contacts).toContain('<p class="zero-greet">Everyone who calls shows up here.</p>')
  })

  test('a contact search without results says so, with no second line', () => {
    expect(contactsEmptyCopy(' sa ')).toEqual({ title: 'No contact matches “sa”', line: null, mark: 'contact' })
    const html = renderToStaticMarkup(<ZeroState {...contactsEmptyCopy('sa')} />)
    expect(html).not.toContain('zero-greet')
    expect(html).toContain('zero-contact')
  })
})
