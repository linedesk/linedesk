// The pages besides the inbox. To add one: add an entry here; its key is the route and the URL
// hash (`#account`), and the navigation, ⌘K and the page title pick it up from this table.
import type { ReactNode } from 'react'
import { AccountSettings } from '../settings/account/index.tsx'
import { AssistantSettings } from '../settings/AssistantSettings.tsx'

export type PageProps = { toast: (text: string) => void; canEditSettings: boolean }
type Page = { title: string; render: (props: PageProps) => ReactNode }

export const pages = {
  assistant: { title: 'Assistant', render: p => <AssistantSettings canEdit={p.canEditSettings} toast={p.toast} /> },
  account: { title: 'Account settings', render: () => <AccountSettings /> },
} satisfies Record<string, Page>

export type PageRoute = keyof typeof pages
export type Route = 'calls' | PageRoute
export const isPageRoute = (value: string): value is PageRoute => Object.hasOwn(pages, value)
