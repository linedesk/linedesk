// The frame of a full-window list page (the inbox views, Contacts): one header bar with the page's title
// at the left and its actions and Search (/) at the right, which the search field replaces while it is
// open; the column headings and rows below (ColumnHeads in list.tsx); one empty state in the middle of the
// list; the shortcut hints at the bottom. Styles: `.ib-head`, `.ib-search`, `.ib-mode`, `.zero`, `.ib-hint`
// in styles.css and app.css.
import type { ReactNode } from 'react'
import { Button, Icon, Kbd } from './kit.tsx'

/** The page's visible title at the left of the header bar, with the number of items in it. */
export function PageTitle({ title, count }: { title: string; count?: number }) {
  return (
    <h1 className="ib-mode ib-title">
      <b>{title}</b>
      {count ? <span className="n">{count}</span> : null}
    </h1>
  )
}

/** The header's Search button: quiet, with its key; it opens the search field in place of the bar. */
export function SearchButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button size="sm" variant="ghost" icon="search" shortcut={['/']} title={`${label} (/)`} onClick={onClick}>
      Search
    </Button>
  )
}

type SearchFieldProps = {
  id: string
  value: string
  placeholder: string
  label: string
  onChange: (query: string) => void
  onClose: () => void
  /** Esc in the field closes the search here; without it the app's key handler does (the inbox's search). */
  escapeCloses?: boolean
}

/**
 * The search field across the header bar while a search is open. Enter or ↓ leaves the field for the
 * results (J and K move there); Close or Esc ends the search.
 */
export function SearchField({ id, value, placeholder, label, onChange, onClose, escapeCloses }: SearchFieldProps) {
  return (
    <div className="ib-search">
      <Icon name="search" size={15} />
      <input
        id={id}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === 'ArrowDown') {
            e.preventDefault()
            e.currentTarget.blur()
          }
          if (e.key === 'Escape' && escapeCloses) onClose() // the app's key handler then blurs the field
        }}
      />
      <Button size="sm" variant="ghost" shortcut={['esc']} title="Close search (esc)" onClick={onClose}>
        Close
      </Button>
    </div>
  )
}

/** The shortcut line under a list: J K move first, then the page's own keys. */
export function ShortcutHints({ hints }: { hints: [keys: string[], label: string][] }) {
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

/** The mark in the sun of the empty-state picture: a check for the inbox, a person for Contacts. */
export type ZeroMark = 'check' | 'contact'

function ZeroArt({ mark }: { mark: ZeroMark }) {
  return (
    <svg className="zero-art" width={168} height={112} viewBox="0 0 168 112" aria-hidden="true" focusable="false">
      <circle cx={84} cy={70} r={34} className="zero-sun" />
      <rect x={0} y={70} width={168} height={42} className="zero-ground" />
      <path d="M8 70h152" className="zero-line" />
      <path d="M30 84h44M96 84h36M52 96h64" className="zero-wave" />
      {mark === 'contact' ? (
        <path d="M80 51a4 4 0 1 0 8 0a4 4 0 1 0 -8 0M77 63.5a7 5.5 0 0 1 14 0" className="zero-mark zero-contact" />
      ) : (
        <path d="M74 58l7 7 14-14" className="zero-mark zero-check" />
      )}
    </svg>
  )
}

/**
 * The one empty state of a list page: the same picture in the middle of the list, below the column
 * headings, a title and at most one line under it. The mark in the picture says what the list holds:
 * the inbox's check (the default) or Contacts' person.
 */
export function ZeroState({ title, line, mark = 'check' }: { title: ReactNode; line?: ReactNode; mark?: ZeroMark }) {
  return (
    <div className="zero" role="status">
      <ZeroArt mark={mark} />
      <h2>{title}</h2>
      {line && <p className="zero-greet">{line}</p>}
    </div>
  )
}
