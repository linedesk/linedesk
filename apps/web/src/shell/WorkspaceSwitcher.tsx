// The workspaces a member belongs to, in the profile dropdown: the current one is checked, choosing
// another makes it active and reloads into it (each workspace has its own local store).
import { useEffect, useState, type KeyboardEvent } from 'react'
import { auth } from '../auth.ts'
import { Icon } from '../ui/kit.tsx'

type Workspace = { id: string; name: string }

/** From this many workspaces the list gets a filter field and scrolls instead of growing. */
export const WORKSPACE_FILTER_FROM = 6

/** Workspaces that match the filter, by name, case-insensitive; the current one always first. */
export function filterWorkspaces(all: Workspace[], currentId: string, query: string): Workspace[] {
  const q = query.trim().toLowerCase()
  const byName = [...all].sort((a, b) => a.name.localeCompare(b.name))
  const current = byName.filter(w => w.id === currentId)
  const others = byName.filter(w => w.id !== currentId && (!q || w.name.toLowerCase().includes(q)))
  return q ? others : [...current, ...others]
}

function useWorkspaces(): Workspace[] | null {
  const [list, setList] = useState<Workspace[] | null>(null)
  useEffect(() => {
    auth.organization.list().then(
      r => setList((r.data ?? []).map(o => ({ id: o.id, name: o.name }))),
      () => setList(null),
    )
  }, [])
  return list
}

async function switchTo(id: string) {
  const r = await auth.organization.setActive({ organizationId: id })
  if (r.error) throw new Error(r.error.message ?? 'Could not switch the workspace')
  window.location.hash = '#calls'
  window.location.reload()
}

/** The workspace section of the profile dropdown; renders nothing for a member of one workspace. */
export function WorkspaceSwitcher({ currentId, onError }: { currentId: string; onError: (message: string) => void }) {
  const all = useWorkspaces()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  if (!all || all.length < 2) return null
  const many = all.length >= WORKSPACE_FILTER_FROM
  const shown = filterWorkspaces(all, currentId, query)

  const choose = (id: string) => () => {
    if (id === currentId || busy) return
    setBusy(id)
    switchTo(id).catch(e => { setBusy(null); onError(e instanceof Error ? e.message : String(e)) })
  }
  // Arrow down from the filter moves into the list; other keys type into it.
  const onFilterKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'ArrowDown') return
    e.preventDefault()
    e.currentTarget.closest('.me-ws')?.querySelector<HTMLElement>('[role="menuitemradio"]')?.focus()
  }

  return (
    <div className="me-ws" role="group" aria-label="Workspaces">
      <div className="me-ws-head">Workspaces</div>
      {many && (
        <input
          className="me-ws-filter"
          type="search"
          placeholder={`Find among ${all.length} workspaces…`}
          aria-label="Find a workspace"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onFilterKey}
        />
      )}
      <div className={many ? 'me-ws-list is-scroll' : 'me-ws-list'}>
        {shown.map(w => (
          <button key={w.id} type="button" role="menuitemradio" aria-checked={w.id === currentId} className="nav-item" onClick={choose(w.id)} title={w.id === currentId ? 'Current workspace' : `Switch to ${w.name}`}>
            <Icon name={w.id === currentId ? 'check' : 'spark'} size={15} className={w.id === currentId ? undefined : 'me-ws-mark'} />
            <span className="lbl">{w.name}</span>
            {busy === w.id && <span className="me-ws-busy">Switching…</span>}
          </button>
        ))}
        {shown.length === 0 && <div className="me-ws-none">No workspace matches “{query}”.</div>}
      </div>
    </div>
  )
}
