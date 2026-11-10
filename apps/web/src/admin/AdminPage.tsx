// The admin area: the operator's view above the workspaces. Only instance admins get here.
import { useCallback, useEffect, useState } from 'react'
import { type AdminData, loadAdminData } from './api.ts'
import { Providers } from './Providers.tsx'
import { System } from './System.tsx'
import { Usage } from './Usage.tsx'
import { Users } from './Users.tsx'
import { Workspaces } from './Workspaces.tsx'
import './admin.css'

const sections = [
  ['adm-workspaces', 'Workspaces'],
  ['adm-users', 'Users'],
  ['adm-usage', 'Usage'],
  ['adm-providers', 'Providers'],
  ['adm-system', 'System'],
] as const

type Props = { isInstanceAdmin: boolean; currentUserId: string; toast: (text: string) => void }

export function AdminPage({ isInstanceAdmin, currentUserId, toast }: Props) {
  const [data, setData] = useState<AdminData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(async () => {
    try {
      setData(await loadAdminData())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])
  useEffect(() => {
    if (isInstanceAdmin) void reload()
  }, [isInstanceAdmin, reload])

  if (!isInstanceAdmin)
    return <Notice title="Admin is for instance admins" text="Ask the operator of this install for access." />
  if (!data)
    return error ? <Notice title="Admin could not be loaded" text={error} /> : <div className="page" aria-busy="true" />

  const shared = { toast, reload }
  return (
    <div className="page">
      <div className="page-in adm-page">
        <div className="page-head">
          <div>
            <h1>Admin</h1>
            <p>
              {data.workspaces.length} workspaces, {data.users.length} users on this install.
            </p>
          </div>
        </div>
        <nav className="st-index" aria-label="Sections">
          {sections.map(([id, label]) => (
            // Not a hash link: the hash is the app's route.
            <button
              key={id}
              type="button"
              className="st-index-a adm-index"
              onClick={() => document.getElementById(id)?.scrollIntoView({ block: 'start' })}
            >
              {label}
            </button>
          ))}
        </nav>
        {error && (
          <p className="adm-notice" role="alert">
            Could not refresh: {error}
          </p>
        )}
        <Workspaces workspaces={data.workspaces} {...shared} />
        <Users users={data.users} currentUserId={currentUserId} {...shared} />
        <Usage workspaces={data.workspaces} usage={data.usage} months={data.usageMonths} />
        <Providers providers={data.providers} active={data.activeProviders} canStore={data.canStoreKeys} {...shared} />
        <System />
      </div>
    </div>
  )
}

function Notice({ title, text }: { title: string; text: string }) {
  return (
    <div className="page">
      <div className="page-in">
        <div className="empty">
          <b>{title}</b>
          <span>{text}</span>
        </div>
      </div>
    </div>
  )
}
