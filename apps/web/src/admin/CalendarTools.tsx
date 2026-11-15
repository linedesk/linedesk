// Server admin › Providers › Calendar: which calendar tools members may connect, and how. Off by default; CalDAV with
// the member's own app-specific password; Calendly and Cal.com with the member's own key, or with one click through
// the install's OAuth app (set up in the list below).
import type { CalendarTool, CalendarToolMode, CalendarToolsData } from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { SelectRow, SkeletonSelectRow } from '../settings/fields.tsx'
import { Loading } from '../ui/LoadStates.tsx'
import type { SelectOption } from '../ui/controls.tsx'
import { runAdmin } from './api.ts'

const TOOLS_QUERY = 'admin.calendarTools'
const loadTools = async () => (await runAdmin('calendarTools.get', {})) as CalendarToolsData

type Translate = ReturnType<typeof useT>

/** Each tool's texts: one full sentence per mode, so every language can word it whole. */
const TOOL: Record<
  CalendarTool,
  {
    title: MessageKey
    keys: MessageKey
    keysState: MessageKey
    oauth?: MessageKey
    oauthState?: MessageKey
    setUpApp?: MessageKey
  }
> = {
  caldav: {
    title: msg('admin.calendarTools.caldav.title'),
    keys: msg('admin.calendarTools.caldav.keys'),
    keysState: msg('admin.calendarTools.caldav.keysState'),
  },
  calendly: {
    title: msg('admin.calendarTools.calendly.title'),
    keys: msg('admin.calendarTools.calendly.keys'),
    keysState: msg('admin.calendarTools.calendly.keysState'),
    oauth: msg('admin.calendarTools.calendly.oauth'),
    oauthState: msg('admin.calendarTools.calendly.oauthState'),
    setUpApp: msg('admin.calendarTools.calendly.setUpApp'),
  },
  calcom: {
    title: msg('admin.calendarTools.calcom.title'),
    keys: msg('admin.calendarTools.calcom.keys'),
    keysState: msg('admin.calendarTools.calcom.keysState'),
    oauth: msg('admin.calendarTools.calcom.oauth'),
    oauthState: msg('admin.calendarTools.calcom.oauthState'),
    setUpApp: msg('admin.calendarTools.calcom.setUpApp'),
  },
}

function optionsOf(t: Translate, tool: CalendarTool, hasApp: boolean): SelectOption<CalendarToolMode>[] {
  const texts = TOOL[tool]
  return [
    {
      value: 'off',
      label: t('admin.calendarTools.mode.off'),
      description: t('admin.calendarTools.mode.offDescription'),
    },
    {
      value: 'keys',
      label: tool === 'caldav' ? t('admin.calendarTools.mode.on') : t('admin.calendarTools.mode.ownKey'),
      description: t(texts.keys),
    },
    ...(texts.oauth && texts.setUpApp
      ? [
          {
            value: 'oauth' as const,
            label: t('admin.calendarTools.mode.oneClick'),
            description: t(hasApp ? texts.oauth : texts.setUpApp),
          },
        ]
      : []),
  ]
}

function describe(t: Translate, tool: CalendarTool, mode: CalendarToolMode): string {
  if (mode === 'off') return t('admin.calendarTools.offState')
  const texts = TOOL[tool]
  if (mode === 'keys' || !texts.oauthState) return t(texts.keysState)
  return t(texts.oauthState)
}

export function CalendarTools() {
  const t = useT()
  const query = useQuery(TOOLS_QUERY, loadTools)
  const [problem, setProblem] = useState<string | null>(null)
  const data = query.data
  async function change(tool: CalendarTool, mode: CalendarToolMode) {
    if (!data) return
    setProblem(null)
    setQueryData<CalendarToolsData | undefined>(TOOLS_QUERY, { ...data, modes: { ...data.modes, [tool]: mode } })
    try {
      setQueryData(TOOLS_QUERY, (await runAdmin('calendarTools.set', { tool, mode })) as CalendarToolsData)
    } catch (e) {
      setQueryData<CalendarToolsData | undefined>(TOOLS_QUERY, data)
      setProblem(e instanceof Error ? e.message : t('admin.calendarTools.couldNotChange'))
    }
  }
  const tools = Object.keys(TOOL) as CalendarTool[]
  return (
    <div className="adm-calendar-tools">
      <Loading
        what={t('admin.calendarTools.loading')}
        loading={!data}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={
          <>
            {tools.map(tool => (
              <SkeletonSelectRow key={tool} title={t(TOOL[tool].title)} />
            ))}
          </>
        }
      >
        {data &&
          tools.map(tool => (
            <SelectRow
              key={tool}
              id={`adm-calendar-${tool}`}
              title={t(TOOL[tool].title)}
              description={describe(t, tool, data.modes[tool])}
              value={data.modes[tool]}
              options={optionsOf(t, tool, data.apps.includes(tool))}
              onChange={mode => void change(tool, mode)}
            />
          ))}
      </Loading>
      {problem && (
        <p className="k-field-msg" role="alert">
          {problem}
        </p>
      )}
    </div>
  )
}
