// A workspace's square: its icon (Workspace settings › General) or, without one, the initial of its name. On the
// workspace button, in the switcher rows and as the preview in General. An icon that fails to load shows the initial.
import { type ReactNode, useState } from 'react'
import { cx } from '../ui/kit.tsx'

/** The first letter of the workspace's name, for its square at the top of the navigation. */
export const workspaceInitial = (name: string) => [...name.trim()][0]?.toUpperCase() ?? '?'

/** The icon address of workspace `id` in the member's list, or null (no icon, or the list is not known). */
export const workspaceIconOf = (list: { id: string; iconUrl?: string | null }[] | null | undefined, id: string) =>
  list?.find(w => w.id === id)?.iconUrl ?? null

type Props = {
  name: string
  iconUrl: string | null | undefined
  size?: 'sm' | 'md' | 'lg'
  /** Drawn over the square (the invitation dot). */
  children?: ReactNode
}

export function WorkspaceMark({ name, iconUrl, size = 'md', children }: Props) {
  // The address that failed to load; a new icon (a new address) is tried again.
  const [failed, setFailed] = useState<string | null>(null)
  const icon = iconUrl && failed !== iconUrl ? iconUrl : null
  return (
    <span className={cx('ws-initial', size !== 'md' && `is-${size}`, icon && 'has-icon')} aria-hidden="true">
      {icon ? <img src={icon} alt="" onError={() => setFailed(icon)} /> : workspaceInitial(name)}
      {children}
    </span>
  )
}
