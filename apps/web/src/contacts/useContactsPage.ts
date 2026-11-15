// What the Contacts page shows and what is selected. It keeps its place while a call is open,
// so Esc in that call comes back to the same contact, search and row.
import { useEffect, useMemo, useRef, useState } from 'react'
import { setPageKeys } from '../shell/keys.ts'
import { contactHash, contactIdOf } from '../shell/useRoute.ts'
import { useRows } from '../store.tsx'
import { useLoadState } from '../ui/LoadStates.tsx'
import { contactRows, filterContactRows } from './model.ts'

export const CONTACT_SEARCH_ID = 'contact-search'

/** `searching`: the search field is open in the header (like the inbox's). `creating`: the New contact form is open. */
export type Place = { query: string; searching: boolean; cursorId: string | null; openId: string | null; creating: boolean }
let remembered: Place = { query: '', searching: false, cursorId: null, openId: null, creating: false }

/** The place a `#contacts/<id>` link asks for: that contact open and under the cursor; any other hash keeps `place`. */
export function placeFromHash(place: Place, hash: string): Place {
  const id = contactIdOf(hash)
  return id ? { ...place, cursorId: id, openId: id, creating: false } : place
}

/** Focus the search field once it is rendered (it replaces the header when the search opens). */
function focusSearch() {
  requestAnimationFrame(() => {
    const el = document.getElementById(CONTACT_SEARCH_ID) as HTMLInputElement | null
    el?.focus()
    el?.select()
  })
}

/** `remove` deletes a contact (with undo); it is the page's # key. */
export function useContactsPage({ remove }: { remove: (contactId: string) => void }) {
  const contacts = useRows('contacts')
  const calls = useRows('calls')
  // A link to one contact (`#contacts/<id>`) opens it; otherwise the page is where it was left.
  const [place, setPlace] = useState(() => placeFromHash(remembered, window.location.hash))
  useEffect(() => {
    remembered = place
  }, [place])
  // The address names the open contact, so the panel can be shared and stays open on reload (replaced: Back leaves
  // the page, it does not step through contacts).
  useEffect(() => {
    const now = window.location.hash.split('?')[0]!
    const want = place.openId ? contactHash(place.openId) : '#contacts'
    if (now !== want && /^#contacts(\/|$)/.test(now)) window.history.replaceState(null, '', want)
  }, [place.openId])
  // A contact link opened while the page is shown (pasted, or Back/Forward).
  useEffect(() => {
    const onHash = () => setPlace(p => placeFromHash(p, window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const all = useMemo(() => contactRows(contacts, calls), [contacts, calls])
  const rows = useMemo(() => filterContactRows(all, place.query), [all, place.query])
  const cursor = rows.find(r => r.contact.id === place.cursorId) ?? rows[0]
  const opened = all.find(r => r.contact.id === place.openId)
  // A link to a contact that is not there (deleted, merged, the test-call contact): the list, without the panel.
  const loaded = useLoadState('contacts') === 'ready'
  useEffect(() => {
    if (loaded && place.openId && !opened) setPlace(p => ({ ...p, openId: null }))
  }, [loaded, place.openId, opened])
  // A contact just added shows up once it is synced; then its record opens.
  const [awaiting, setAwaiting] = useState<string | null>(null)
  useEffect(() => {
    const added = awaiting && all.find(r => r.contact.phone === awaiting)
    if (!added) return
    setAwaiting(null)
    setPlace(p => ({
      ...p,
      query: '',
      searching: false,
      cursorId: added.contact.id,
      openId: added.contact.id,
      creating: false,
    }))
  }, [awaiting, all])

  const update = (next: Partial<Place>) => setPlace(p => ({ ...p, ...next }))
  const select = (id: string) => update({ cursorId: id, openId: place.openId ? id : null }) // an open record follows the cursor
  const open = (id: string) => update({ cursorId: id, openId: id, creating: false })
  const startCreate = () => update({ creating: true, openId: null })
  const openSearch = () => {
    update({ searching: true })
    focusSearch()
  }
  const closeSearch = () => update({ searching: false, query: '', cursorId: null })
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
    else if (key === '/') openSearch()
    else if (key === 'n') startCreate()
    else if (key === '#' && cursor) remove(cursor.contact.id)
    else if (key === 'Escape' && place.creating) update({ creating: false })
    else if (key === 'Escape' && place.openId) update({ openId: null })
    else if (key === 'Escape' && place.searching) closeSearch()
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
    searching: place.searching,
    openSearch,
    closeSearch,
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
