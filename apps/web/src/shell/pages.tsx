// The pages besides the inbox. To add one: add an entry here; its key is the route and the URL
// hash (`#account`), and the navigation, ⌘K and the page title pick it up from this table.
import type { ReactNode } from 'react'
import { AdminNotice } from '../admin/AdminMode.tsx'
import { AccountSettings } from '../settings/account/index.tsx'
import { AssistantSettings } from '../settings/AssistantSettings.tsx'

export type PageProps = { toast: (text: string) => void; canEditSettings: boolean; isInstanceAdmin: boolean; userId: string }
type Page = { title: string; render: (props: PageProps) => ReactNode }

export const pages = {
  assistant: { title: 'Assistant', render: p => <AssistantSettings canEdit={p.canEditSettings} toast={p.toast} /> },
  account: { title: 'Account settings', render: () => <AccountSettings /> },
  // Shown in the navigation and ⌘K to instance admins only; the API refuses everyone else.
  // Instance admins get admin mode instead (Workspace.tsx); anyone else who opens #admin sees this.
  admin: { title: 'Admin', render: () => <AdminNotice /> },
} satisfies Record<string, Page>

export type PageRoute = keyof typeof pages
export type Route = 'calls' | PageRoute
export const isPageRoute = (value: string): value is PageRoute => Object.hasOwn(pages, value)
