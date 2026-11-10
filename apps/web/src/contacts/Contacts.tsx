// Contacts: everyone who has called, newest call first. Same list model as the inbox; the record opens beside it.
import type { Call } from '@callfront/db/types'
import { useEffect, useRef, type ReactNode } from 'react'
import { callTitle } from '../inbox-model.ts'
import { parseTs, timeLabel } from '../time.ts'
import { cx, Icon, Kbd } from '../ui/kit.tsx'
import { ContactDetail } from './ContactDetail.tsx'
import './contacts.css'
import { contactLabel, type ContactRow } from './model.ts'
import { CONTACT_SEARCH_ID, useContactsPage } from './useContactsPage.ts'

type Props = { menu: ReactNode; toast: (text: string) => void; openCall: (call: Call) => void }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function SearchBar({ query, shown, total, onChange }: { query: string; shown: number; total: number; onChange: (query: string) => void }) {
  return (
    <div className="ib-search">
      <Icon name="search" size={15} />
      <input id={CONTACT_SEARCH_ID} value={query} placeholder="Search contacts" aria-label="Search contacts" autoComplete="off" title="Search contacts (/)"
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); e.currentTarget.blur() }
          if (e.key === 'Escape' && query) onChange('') // the app's key handler then blurs the field
        }} />
      {total ? <span className="ib-search-n">{query ? `${shown} of ${total}` : plural(total, 'contact')}</span> : null}
    </div>
  )
}

function Row({ row, isCursor, onOpen, onHover }: { row: ContactRow; isCursor: boolean; onOpen: () => void; onHover: () => void }) {
  const { contact, lastCall, nextStep } = row
  return (
    <div role="listitem" className={cx('row', 'cust-row', 'ct-row', isCursor && 'is-cursor')} onClick={onOpen} onMouseMove={() => { if (!isCursor) onHover() }}>
      <span className="r-name c-name"><span>{contactLabel(contact)}</span></span>
      <span className="c-cell c-company">{contact.company}</span>
      <span className="c-cell c-sum">{lastCall && <span className="c-sum-t">{callTitle(lastCall)}</span>}{nextStep && <span className="c-next"> · {nextStep}</span>}</span>
      <span className="c-cell c-count">{plural(row.calls.length, 'call')}</span>
      <span className="c-cell c-last">{lastCall ? timeLabel(parseTs(lastCall.started_at)) : '—'}</span>
    </div>
  )
}

function Empty({ query }: { query: string }) {
  return (
    <div className="empty">
      <Icon name="users" size={22} />
      {query
        ? <><b>No contact matches “{query}”</b><span>Try a name, a company, an email or part of the number.</span></>
        : <><b>No contacts yet</b><span>Everyone who calls shows up here, with their calls and what they called about.</span></>}
    </div>
  )
}

function Hints({ open }: { open: boolean }) {
  const hints: [string[], string][] = [[['⏎'], 'open'], [['/'], 'search'], ...(open ? [[['esc'], 'close'] as [string[], string]] : []), [['?'], 'all shortcuts']]
  return (
    <div className="ib-hint">
      <span><Kbd keys={['J']} /><Kbd keys={['K']} />move</span>
      {hints.map(([keys, label]) => <span key={label}><Kbd keys={keys} />{label}</span>)}
    </div>
  )
}

export function Contacts({ menu, toast, openCall }: Props) {
  const page = useContactsPage()
  const { rows, cursor, opened, query } = page
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (cursor) listRef.current?.querySelector('.is-cursor')?.scrollIntoView({ block: 'nearest' }) }, [cursor])
  return (
    <div className="cv">
      <div className="ib-head">
        {menu}
        <SearchBar query={query} shown={rows.length} total={page.all.length} onChange={page.setQuery} />
      </div>
      <div className={cx('cv-main', 'cust-main', opened && 'has-rec')}>
        <div className="cv-center">
          <div className="ib-list" ref={listRef} role="list" aria-label="Contacts">
            {rows.map(row => (
              <Row key={row.contact.id} row={row} isCursor={cursor === row} onOpen={() => page.open(row.contact.id)} onHover={() => page.hover(row.contact.id)} />
            ))}
            {!rows.length && <Empty query={query} />}
          </div>
          {rows.length ? <Hints open={!!opened} /> : null}
        </div>
        {opened && <ContactDetail row={opened} toast={toast} onOpenCall={openCall} onClose={page.close} />}
      </div>
    </div>
  )
}
