// Contacts: everyone who has called, newest call first. Same list model as the inbox; the record opens beside it.
import type { Call } from '@linedesk/db/types'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Step } from '../inbox/changes.ts'
import { callTitle } from '../inbox-model.ts'
import { parseTs, timeLabel } from '../time.ts'
import { Button, cx, Icon, Kbd } from '../ui/kit.tsx'
import { LoadProblem, SkeletonRows, useLoadState } from '../ui/LoadStates.tsx'
import { ContactDetail } from './ContactDetail.tsx'
import './contacts.css'
import { ImportContacts } from './ImportContacts.tsx'
import { MergeContacts } from './MergeContacts.tsx'
import { contactLabel, type ContactRow, duplicatePairs } from './model.ts'
import { NewContact } from './NewContact.tsx'
import { CONTACT_SEARCH_ID, useContactsPage } from './useContactsPage.ts'

type Props = {
  menu: ReactNode
  toast: (text: string) => void
  openCall: (call: Call) => void
  runUndoable: (steps: Step[], inverse: Step[], label: string, key: string) => void
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function SearchBar({
  query,
  shown,
  total,
  onChange,
}: {
  query: string
  shown: number
  total: number
  onChange: (query: string) => void
}) {
  return (
    <div className="ib-search">
      <Icon name="search" size={15} />
      <input
        id={CONTACT_SEARCH_ID}
        value={query}
        placeholder="Search contacts"
        aria-label="Search contacts"
        autoComplete="off"
        title="Search contacts (/)"
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === 'ArrowDown') {
            e.preventDefault()
            e.currentTarget.blur()
          }
          if (e.key === 'Escape' && query) onChange('') // the app's key handler then blurs the field
        }}
      />
      {total ? <span className="ib-search-n">{query ? `${shown} of ${total}` : plural(total, 'contact')}</span> : null}
    </div>
  )
}

function Row({
  row,
  isCursor,
  onOpen,
  onHover,
}: {
  row: ContactRow
  isCursor: boolean
  onOpen: () => void
  onHover: () => void
}) {
  const { contact, lastCall, nextStep } = row
  return (
    <div
      role="listitem"
      className={cx('row', 'cust-row', 'ct-row', isCursor && 'is-cursor')}
      onClick={onOpen}
      onMouseMove={() => {
        if (!isCursor) onHover()
      }}
    >
      <span className="r-name c-name">
        <span>{contactLabel(contact)}</span>
      </span>
      <span className="c-cell c-company">{contact.company}</span>
      <span className="c-cell c-sum">
        {lastCall && <span className="c-sum-t">{callTitle(lastCall)}</span>}
        {nextStep && <span className="c-next"> · {nextStep}</span>}
      </span>
      <span className="c-cell c-count">{plural(row.calls.length, 'call')}</span>
      <span className="c-cell c-last">{lastCall ? timeLabel(parseTs(lastCall.started_at)) : '—'}</span>
    </div>
  )
}

function Empty({ query }: { query: string }) {
  return (
    <div className="empty">
      <Icon name="users" size={22} />
      {query ? (
        <>
          <b>No contact matches “{query}”</b>
        </>
      ) : (
        <>
          <b>No contacts yet</b>
          <span>Everyone who calls shows up here.</span>
        </>
      )}
    </div>
  )
}

function Hints({ open }: { open: boolean }) {
  const hints: [string[], string][] = [
    [['⏎'], 'open'],
    [['/'], 'search'],
    [['N'], 'new'],
    ...(open ? [[['esc'], 'close'] as [string[], string]] : []),
    [['?'], 'all shortcuts'],
  ]
  return (
    <div className="ib-hint">
      <span>
        <Kbd keys={['J']} />
        <Kbd keys={['K']} />
        move
      </span>
      {hints.map(([keys, label]) => (
        <span key={label}>
          <Kbd keys={keys} />
          {label}
        </span>
      ))}
    </div>
  )
}

export function Contacts({ menu, toast, openCall, runUndoable }: Props) {
  const remove = (contactId: string) =>
    runUndoable(
      [['contact.delete', { contactId }]],
      [['contact.restore', { contactId }]],
      'Contact deleted. Their calls stay.',
      '#',
    )
  const page = useContactsPage({ remove })
  const loadState = useLoadState('contacts')
  const numbers = useMemo(() => new Set(page.all.map(r => r.contact.phone)), [page.all])
  const { rows, cursor, opened, query } = page
  const [importing, setImporting] = useState(false)
  const [merging, setMerging] = useState<{ first: ContactRow; second: ContactRow | null } | null>(null)
  const duplicates = useMemo(() => {
    const byId = new Map(page.all.map(r => [r.contact.id, r]))
    return duplicatePairs(page.all.map(r => r.contact)).map(([a, b]) => [byId.get(a.id)!, byId.get(b.id)!] as const)
  }, [page.all])
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (cursor) listRef.current?.querySelector('.is-cursor')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])
  return (
    <div className="cv">
      <h1 className="sr-only">Contacts</h1>
      <div className="ib-head ct-head">
        {menu}
        <SearchBar query={query} shown={rows.length} total={page.all.length} onChange={page.setQuery} />
        <Button
          size="sm"
          variant="ghost"
          icon="plus"
          shortcut={['N']}
          aria-label="New contact"
          title="New contact (N)"
          onClick={page.startCreate}
        >
          New contact
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="attach"
          aria-label="Import contacts"
          title="Import contacts from a CSV file"
          onClick={() => setImporting(true)}
        >
          Import
        </Button>
      </div>
      <div className={cx('cv-main', 'cust-main', (opened || page.creating) && 'has-rec')}>
        <div className="cv-center">
          {duplicates.length > 0 && !query && (
            <div className="ct-dupes">
              <span>
                {duplicates.length === 1
                  ? `${contactLabel(duplicates[0]![0].contact)} and ${contactLabel(duplicates[0]![1].contact)} may be one person.`
                  : `${duplicates.length} possible duplicates, by number or email.`}
              </span>
              <Button size="sm" onClick={() => setMerging({ first: duplicates[0]![0], second: duplicates[0]![1] })}>
                Review
              </Button>
            </div>
          )}
          <div className="ib-list" ref={listRef} role="list" aria-label="Contacts">
            {rows.map(row => (
              <Row
                key={row.contact.id}
                row={row}
                isCursor={cursor === row}
                onOpen={() => page.open(row.contact.id)}
                onHover={() => page.hover(row.contact.id)}
              />
            ))}
            {loadState === 'loading' ? (
              <SkeletonRows label="Loading contacts" />
            ) : loadState === 'slow' ? (
              <LoadProblem what="Contacts" />
            ) : (
              !rows.length && <Empty query={query} />
            )}
          </div>
          {rows.length ? <Hints open={!!opened} /> : null}
        </div>
        {page.creating ? (
          <NewContact existing={numbers} onAdded={page.added} onClose={page.stopCreate} />
        ) : (
          opened && (
            <ContactDetail
              row={opened}
              toast={toast}
              onOpenCall={openCall}
              onClose={page.close}
              onDelete={remove}
              onMerge={() => setMerging({ first: opened, second: null })}
              runUndoable={runUndoable}
            />
          )
        )}
      </div>
      {importing && <ImportContacts onClose={() => setImporting(false)} toast={toast} />}
      {merging && (
        <MergeContacts
          first={merging.first}
          second={merging.second}
          all={page.all}
          onClose={() => setMerging(null)}
          toast={toast}
        />
      )}
    </div>
  )
}
