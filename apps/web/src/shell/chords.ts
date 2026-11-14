// G chords (G then a letter): where each one goes. Pure, so the keys can be tested without the app (Workspace.tsx runs
// the result). G S opens Workspace settings at General, G T its Team section.
import { assigneeTabs, type InboxTab } from '../inbox-model.ts'
import type { PageRoute } from './pages.tsx'

const chordTabs: Record<string, InboxTab> = {
  i: 'you',
  e: 'done',
  h: 'reminders',
  m: 'mine',
  u: 'unassigned',
}
const chordPages: Record<string, { route: PageRoute; section?: string }> = {
  a: { route: 'assistant' },
  c: { route: 'contacts' },
  r: { route: 'assistant', section: 'review' },
  n: { route: 'insights' },
  s: { route: 'workspace' },
  t: { route: 'workspace', section: 'team' },
}

export type ChordTarget = { kind: 'page'; route: PageRoute; section?: string } | { kind: 'tab'; tab: InboxTab }

/**
 * Where G then `key` goes for this member, or null when it goes nowhere (then the key does nothing): Admin (D) for
 * instance admins, How <assistant> did (R, in the Assistant area) for owners and admins, the assignee views once
 * someone else can be assigned.
 */
export function chordTarget(
  key: string,
  can: { instanceAdmin: boolean; review: boolean; assign: boolean },
): ChordTarget | null {
  if (key === 'd') return can.instanceAdmin ? { kind: 'page', route: 'admin' } : null
  if (key === 'r' && !can.review) return null
  const page = Object.hasOwn(chordPages, key) ? chordPages[key] : undefined
  if (page) return { kind: 'page', ...page }
  const tab = Object.hasOwn(chordTabs, key) ? chordTabs[key] : undefined
  if (!tab) return null
  if (assigneeTabs.includes(tab) && !can.assign) return null
  return { kind: 'tab', tab }
}
