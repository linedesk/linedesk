// The bill owner's two billing reads, shared by Settings › Billing (Billing.tsx) and the banner above every page
// (shell/BillingBanner.tsx): one cached answer for both, and a change on the page shows in the banner at once. And the
// usage read of the workspace's owners and admins who do not pay (`billing.workspaceUsage`).
import type { BillingOverviewData, BillingStateData, BillingWorkspaceUsageData } from '@linedesk/actions'
import { readAction } from './settings-api.ts'

export const OVERVIEW = 'billing.overview'
export const STATE = 'billing.state'
export const WORKSPACE_USAGE = 'billing.workspaceUsage'
export const loadOverview = () => readAction<BillingOverviewData>('billing.overview')
export const loadState = () => readAction<BillingStateData>('billing.state')
export const loadWorkspaceUsage = () => readAction<BillingWorkspaceUsageData>('billing.workspaceUsage')
