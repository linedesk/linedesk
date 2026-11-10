// The pages besides the inbox. To add one: add an entry here; its key is the route and the URL
// hash (`#account`), and the navigation, ⌘K and the page title pick it up from this table.
import type { Call } from '@callfront/db/types'
import type { ReactNode } from 'react'
import { AdminNotice } from '../admin/AdminMode.tsx'
import { Contacts } from '../contacts/Contacts.tsx'
import { AccountSettings } from '../settings/account/index.tsx'
import type { PhoneSetupStatus } from '../auth.ts'
import { AssistantSettings } from '../settings/AssistantSettings.tsx'
import { SettingsPage } from '../settings/SettingsPage.tsx'
import { TeamPage } from '../team/TeamPage.tsx'

export type PageProps = {
  toast: (text: string) => void
  canEditSettings: boolean
  isInstanceAdmin: boolean
  userId: string
  menu: ReactNode
  openCall: (call: Call) => void
  phoneSetup: PhoneSetupStatus | null
}
/** `ownHeader`: the page draws its own header (with `menu`) instead of the title bar. */
export type Page = { title: string; render: (props: PageProps) => ReactNode; ownHeader?: boolean }

export const pages = {
  contacts: { title: 'Contacts', ownHeader: true, render: p => <Contacts menu={p.menu} toast={p.toast} openCall={p.openCall} /> },
  assistant: { title: 'Assistant', render: p => <AssistantSettings canEdit={p.canEditSettings} toast={p.toast} /> },
  team: { title: 'Team', render: p => <TeamPage toast={p.toast} /> },
  settings: { title: 'Settings', render: p => <SettingsPage canEdit={p.canEditSettings} phoneSetup={p.phoneSetup} isInstanceAdmin={p.isInstanceAdmin} toast={p.toast} /> },
  account: { title: 'Account settings', render: () => <AccountSettings /> },
  // Shown in the navigation and ⌘K to instance admins only; the API refuses everyone else.
  // Instance admins get admin mode instead (Workspace.tsx); anyone else who opens #admin sees this.
  admin: { title: 'Admin', render: () => <AdminNotice /> },
} satisfies Record<string, Page>

export type PageRoute = keyof typeof pages
export type Route = 'calls' | PageRoute
export const isPageRoute = (value: string): value is PageRoute => Object.hasOwn(pages, value)
