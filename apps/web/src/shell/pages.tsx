// The pages besides the inbox. To add one: add an entry here; its key is the route and the URL
// hash (`#account`), and the navigation, ⌘K and the page title pick it up from this table.
import type { Call } from '@linedesk/db/types'
import type { Step } from '../inbox/changes.ts'
import type { ReactNode } from 'react'
import { AdminNotice } from '../admin/AdminMode.tsx'
import { Contacts } from '../contacts/Contacts.tsx'
import { Insights } from '../insights/Insights.tsx'
import { Integrations } from '../integrations/Integrations.tsx'
import { AccountSettings } from '../settings/account/index.tsx'
import type { PhoneSetupStatus } from '../auth.ts'
import { AssistantSettings } from '../settings/AssistantSettings.tsx'
import { WorkspaceSettings } from '../settings/WorkspaceSettings.tsx'
import { i18n } from '../i18n/index.tsx'

export type PageProps = {
  toast: (text: string) => void
  /** Owners and admins in their own session; never during support access (settingsAccess, settings/readOnly.ts). */
  canEditSettings: boolean
  /** API keys and Zapier (Integrations): owners and admins, also during support access. */
  canManageKeys: boolean
  /** Owners and admins until go-live: the strip to finish the setup on the workspace's and the assistant's settings. */
  agentChange: boolean
  isInstanceAdmin: boolean
  /**
   * Workspace settings › Billing (Linedesk Cloud): `owner` for the person who manages the bill, `usage` for the
   * workspace's admins (this workspace's usage, read-only), null off billing and for members.
   */
  billing: 'owner' | 'usage' | 'none' | null
  /** In this client workspace through a white-label partner's team: Billing says it is on their partner plan. */
  viaPartner: boolean
  /** On a bill: what each number beyond the included one costs a month (from the balance); null otherwise. */
  extraNumberCents: number | null
  userId: string
  menu: ReactNode
  openCall: (call: Call) => void
  phoneSetup: PhoneSetupStatus | null
  /** The current workspace's name, and what to call after renaming it here (the menu shows the new name at once). */
  workspaceName: string
  onRenamed: (name: string) => void
  /** Send a change and offer Undo (Z) in the toast. */
  runUndoable: (steps: Step[], inverse: Step[], label: string, key: string) => void
  /** A change the page made and undoes itself (`revert`): a toast with Undo, also Z. */
  undoable: (label: string, key: string, revert: () => void) => void
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
  insights: {
    get title() {
      return i18n().t('shell.page.insights')
    },
    render: p => <Insights canEdit={p.canEditSettings} toast={p.toast} />,
  },
  assistant: {
    get title() {
      return i18n().t('shell.page.assistant')
    },
    sections: true,
    render: p => (
      <AssistantSettings
        canEdit={p.canEditSettings}
        agentChange={p.agentChange}
        toast={p.toast}
        undoable={p.undoable}
        isInstanceAdmin={p.isInstanceAdmin}
      />
    ),
  },
  // Everything Linedesk connects to, by category, with a detail view per integration that is set up here
  // (#integrations/zapier, #integrations/api-keys, #integrations/rest-api, #integrations/mcp).
  integrations: {
    get title() {
      return i18n().t('shell.page.integrations')
    },
    sections: true,
    render: p => <Integrations canManageKeys={p.canManageKeys} toast={p.toast} />,
  },
  // Everything about the workspace that is not the assistant: its name, the team, numbers, recordings, export
  // and leaving it (#workspace/<section>). Old #settings and #team links are rewritten (useRoute.ts).
  workspace: {
    get title() {
      return i18n().t('shell.page.workspace')
    },
    sections: true,
    render: p => (
      <WorkspaceSettings
        canEdit={p.canEditSettings}
        canManageKeys={p.canManageKeys}
        agentChange={p.agentChange}
        phoneSetup={p.phoneSetup}
        isInstanceAdmin={p.isInstanceAdmin}
        billing={p.billing}
        viaPartner={p.viaPartner}
        extraNumberCents={p.extraNumberCents}
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
    render: () => <AccountSettings hasWorkspace />,
  },
  // Shown in the navigation and ⌘K to instance admins only; the API refuses everyone else.
  // Instance admins get admin mode instead (Workspace.tsx); anyone else who opens #admin sees this.
  admin: {
    get title() {
      return i18n().t('shell.page.admin')
    },
    render: () => <AdminNotice />,
  },
} satisfies Record<string, Page>

export type PageRoute = keyof typeof pages
export type Route = 'calls' | PageRoute
export const isPageRoute = (value: string): value is PageRoute => Object.hasOwn(pages, value)
/** A page whose sections have their own hash (`#workspace/recordings`). */
export const hasSections = (route: PageRoute) => 'sections' in pages[route]
