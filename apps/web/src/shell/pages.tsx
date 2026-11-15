// The pages besides the inbox. To add one: add an entry here; its key is the route and the URL
// hash (`#account`), and the navigation, ⌘K and the page title pick it up from this table.
import type { Call } from '@linedesk/db/types'
import type { Step } from '../inbox/changes.ts'
import type { ReactNode } from 'react'
import { AdminNotice } from '../admin/AdminMode.tsx'
import { Contacts } from '../contacts/Contacts.tsx'
import { Insights } from '../insights/Insights.tsx'
import { AccountSettings } from '../settings/account/index.tsx'
import type { PhoneSetupStatus } from '../auth.ts'
import { AssistantSettings } from '../settings/AssistantSettings.tsx'
import { WorkspaceSettings } from '../settings/WorkspaceSettings.tsx'
import { i18n } from '../i18n/index.tsx'

export type PageProps = {
  toast: (text: string) => void
  canEditSettings: boolean
  isInstanceAdmin: boolean
  userId: string
  menu: ReactNode
  openCall: (call: Call) => void
  phoneSetup: PhoneSetupStatus | null
  /** The current workspace's name, and what to call after renaming it here (the menu shows the new name at once). */
  workspaceName: string
  onRenamed: (name: string) => void
  /** Send a change and offer Undo (Z) in the toast. */
  runUndoable: (steps: Step[], inverse: Step[], label: string, key: string) => void
}
/**
 * `ownHeader`: the page draws its own header (with `menu`) instead of the title bar. `sections`: the
 * page shows one section at a time, named in the hash after the page (`#workspace/recordings`).
 */
export type Page = { title: string; render: (props: PageProps) => ReactNode; ownHeader?: boolean; sections?: true }

export const pages = {
  contacts: {
    get title() {
      return i18n().t('shell.page.contacts')
    },
    ownHeader: true,
    render: p => <Contacts menu={p.menu} toast={p.toast} openCall={p.openCall} runUndoable={p.runUndoable} />,
  },
  insights: { get title() {
      return i18n().t('shell.page.insights')
    }, render: p => <Insights canEdit={p.canEditSettings} toast={p.toast} /> },
  assistant: {
    get title() {
      return i18n().t('shell.page.assistant')
    },
    sections: true,
    render: p => <AssistantSettings canEdit={p.canEditSettings} toast={p.toast} isInstanceAdmin={p.isInstanceAdmin} />,
  },
  // Everything about the workspace that is not the assistant: its name, the team, numbers, recordings, export,
  // API keys and leaving it (#workspace/<section>). Old #settings and #team links are rewritten (useRoute.ts).
  workspace: {
    get title() {
      return i18n().t('shell.page.workspace')
    },
    sections: true,
    render: p => (
      <WorkspaceSettings
        canEdit={p.canEditSettings}
        phoneSetup={p.phoneSetup}
        isInstanceAdmin={p.isInstanceAdmin}
        workspaceName={p.workspaceName}
        onRenamed={p.onRenamed}
        toast={p.toast}
      />
    ),
  },
  account: {
    get title() {
      return i18n().t('shell.page.account')
    },
    sections: true,
    render: p => <AccountSettings hasWorkspace workspaceName={p.workspaceName} />,
  },
  // Shown in the navigation and ⌘K to instance admins only; the API refuses everyone else.
  // Instance admins get admin mode instead (Workspace.tsx); anyone else who opens #admin sees this.
  admin: { get title() {
      return i18n().t('shell.page.admin')
    }, render: () => <AdminNotice /> },
} satisfies Record<string, Page>

export type PageRoute = keyof typeof pages
export type Route = 'calls' | PageRoute
export const isPageRoute = (value: string): value is PageRoute => Object.hasOwn(pages, value)
/** A page whose sections have their own hash (`#workspace/recordings`). */
export const hasSections = (route: PageRoute) => 'sections' in pages[route]
