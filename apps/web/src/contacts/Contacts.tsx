// Contacts: everyone who has called, newest call first. Same list model as the inbox; the record opens beside it.
import type { Call } from '@linedesk/db/types'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Step } from '../inbox/changes.ts'
import { callTitle } from '../inbox-model.ts'
import { parseTs, timeLabel } from '../time.ts'
import { Button, cx } from '../ui/kit.tsx'
import { Loading, SkeletonRows, useLoading, useLoadState } from '../ui/LoadStates.tsx'
import { ColumnHeads } from '../ui/list.tsx'
import { PageTitle, SearchButton, SearchField, ShortcutHints, ZeroState } from '../ui/listPage.tsx'
import { ContactDetail } from './ContactDetail.tsx'
import './contacts.css'
import { ImportContacts } from './ImportContacts.tsx'
import { MergeContacts } from './MergeContacts.tsx'
import { contactLabel, type ContactRow, contactsEmptyCopy, duplicatePairs } from './model.ts'
import { NewContact } from './NewContact.tsx'
import { CONTACT_SEARCH_ID, useContactsPage } from './useContactsPage.ts'

type Props = {
  menu: ReactNode
  toast: (text: string) => void
  openCall: (call: Call) => void
  runUndoable: (steps: Step[], inverse: Step[], label: string, key: string) => void
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

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
      <span className="c-cell c-last">{lastCall ? timeLabel(parseTs(lastCall.started_at)) : '—'}</span>
      <span className="r-name c-name">
        <span>{contactLabel(contact)}</span>
      </span>
      <span className="c-cell c-company">{contact.company}</span>
      <span className="c-cell c-sum">
        {lastCall && <span className="c-sum-t">{callTitle(lastCall)}</span>}
        {nextStep && <span className="c-next"> · {nextStep}</span>}
      </span>
      <span className="c-cell c-count">{plural(row.calls.length, 'call')}</span>
    </div>
  )
}

/** One heading per cell of a row, in the row's order; the time comes first, as in the inbox. */
const CONTACT_COLUMNS = ['When', 'Name', 'Company', 'Last call', 'Calls'] as const

function Hints({ open }: { open: boolean }) {
  return (
    <ShortcutHints
      hints={[
        [['⏎'], 'open'],
        [['/'], 'search'],
        [['N'], 'new'],
        ...(open ? [[['esc'], 'close'] as [string[], string]] : []),
        [['?'], 'all shortcuts'],
      ]}
    />
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
  const listView = useLoading(loadState === 'loading')
  const waiting = loadState !== 'ready' || listView.phase !== 'content'
  const numbers = useMemo(() => new Set(page.all.map(r => r.contact.phone)), [page.all])
  const { rows, cursor, opened, query } = page
  const empty = !waiting && rows.length === 0
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
      <div className="ib-head">
        {menu}
        {page.searching ? (
          <SearchField
            id={CONTACT_SEARCH_ID}
            value={query}
            placeholder="Search names, numbers, companies and emails"
            label="Search contacts"
            onChange={page.setQuery}
            onClose={page.closeSearch}
            escapeCloses
          />
        ) : (
          <>
            <PageTitle title="Contacts" count={page.all.length} />
            <div className="ib-right">
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
              <Button
                size="sm"
                variant="primary"
                icon="plus"
                shortcut={['N']}
                aria-label="New contact"
                title="New contact (N)"
                onClick={page.startCreate}
              >
                New contact
              </Button>
              <SearchButton label="Search contacts" onClick={page.openSearch} />
            </div>
          </>
        )}
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
          <div
            className={cx('ib-list', 'ct-list', empty && 'is-zero', listView.fadeIn && 'ld-rows-in')}
            ref={listRef}
            role="list"
            aria-label="Contacts"
          >
            {/* The headings stand over the skeleton, the rows and the empty state alike (as in the inbox). */}
            <ColumnHeads className="ct-cols" labels={CONTACT_COLUMNS} />
            {!waiting &&
              rows.map(row => (
                <Row
                  key={row.contact.id}
                  row={row}
                  isCursor={cursor === row}
                  onOpen={() => page.open(row.contact.id)}
                  onHover={() => page.hover(row.contact.id)}
                />
              ))}
            {waiting ? (
              <Loading
                what="Contacts"
                loading
                error={loadState === 'slow'}
                skeleton={<SkeletonRows rows={8} columns={5} />}
              />
            ) : (
              empty && <ZeroState {...contactsEmptyCopy(query)} />
            )}
          </div>
          <Hints open={!!opened} />
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
