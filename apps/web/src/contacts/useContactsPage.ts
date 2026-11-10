// What the Contacts page shows and what is selected. It keeps its place while a call is open,
// so Esc in that call comes back to the same contact, search and row.
import { useEffect, useMemo, useRef, useState } from 'react'
import { setPageKeys } from '../shell/keys.ts'
import { useRows } from '../store.tsx'
import { contactRows, filterContactRows } from './model.ts'

export const CONTACT_SEARCH_ID = 'contact-search'

/** `creating`: the New contact form is open. */
type Place = { query: string; cursorId: string | null; openId: string | null; creating: boolean }
let remembered: Place = { query: '', cursorId: null, openId: null, creating: false }

function focusSearch() {
  const el = document.getElementById(CONTACT_SEARCH_ID) as HTMLInputElement | null
  el?.focus()
  el?.select()
}

/** `remove` deletes a contact (with undo); it is the page's # key. */
export function useContactsPage({ remove }: { remove: (contactId: string) => void }) {
  const contacts = useRows('contacts')
  const calls = useRows('calls')
  const [place, setPlace] = useState(remembered)
  useEffect(() => {
    remembered = place
  }, [place])

  const all = useMemo(() => contactRows(contacts, calls), [contacts, calls])
  const rows = useMemo(() => filterContactRows(all, place.query), [all, place.query])
  const cursor = rows.find(r => r.contact.id === place.cursorId) ?? rows[0]
  const opened = all.find(r => r.contact.id === place.openId)
  // A contact just added shows up once it is synced; then its record opens.
  const [awaiting, setAwaiting] = useState<string | null>(null)
  useEffect(() => {
    const added = awaiting && all.find(r => r.contact.phone === awaiting)
    if (!added) return
    setAwaiting(null)
    setPlace(p => ({ ...p, query: '', cursorId: added.contact.id, openId: added.contact.id, creating: false }))
  }, [awaiting, all])

  const update = (next: Partial<Place>) => setPlace(p => ({ ...p, ...next }))
  const select = (id: string) => update({ cursorId: id, openId: place.openId ? id : null }) // an open record follows the cursor
  const open = (id: string) => update({ cursorId: id, openId: id, creating: false })
  const startCreate = () => update({ creating: true, openId: null })
  function step(by: number) {
    const i = cursor ? rows.indexOf(cursor) : -1
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + by))]
    if (next) select(next.contact.id)
  }

  const keys = useRef<(key: string) => boolean>(() => false)
  keys.current = key => {
    if (key === 'j' || key === 'J' || key === 'ArrowDown') step(1)
    else if (key === 'k' || key === 'K' || key === 'ArrowUp') step(-1)
    else if ((key === 'Enter' || key === 'o') && cursor) open(cursor.contact.id)
    else if (key === '/') focusSearch()
    else if (key === 'n') startCreate()
    else if (key === '#' && cursor) remove(cursor.contact.id)
    else if (key === 'Escape' && place.creating) update({ creating: false })
    else if (key === 'Escape' && place.openId) update({ openId: null })
    else if (key === 'Escape' && place.query) update({ query: '' })
    else return false
    return true
  }
  useEffect(() => {
    setPageKeys(key => keys.current(key))
    return () => setPageKeys(null)
  }, [])

  return {
    all,
    rows,
    cursor,
    opened,
    query: place.query,
    creating: place.creating,
    startCreate,
    stopCreate: () => update({ creating: false }),
    added: (phone: string) => setAwaiting(phone),
    setQuery: (query: string) => update({ query, cursorId: null }),
    hover: (id: string) => update({ cursorId: id }),
    open,
    close: () => update({ openId: null }),
  }
}
