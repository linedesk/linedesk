// Server admin › Features (LIN-747, grouped in LIN-810): what workspaces get on this server, under Phone, Voice and
// Integrations. Each feature is one line with its state and Change, which opens its settings in place; the settings
// are the cards they always were, shown without their own title (CardInline).
import type { CalendarToolsData, OutboundCountriesData } from '@linedesk/actions'
import { T, useT } from '@linedesk/i18n/react'
import { type ReactNode, useId, useState } from 'react'
import { brandName } from '../brand.ts'
import { useQuery } from '../cachedQuery.ts'
import { appLink } from '../ui/AppLink.tsx'
import { Card, CardInline, type HelpContent, HelpTip } from '../ui/form.tsx'
import { helpContent } from '../ui/HelpTip.tsx'
import { Badge, Button } from '../ui/kit.tsx'
import { Skeleton } from '../ui/LoadStates.tsx'
import { CalendarTools, loadTools, TOOLS_QUERY } from './CalendarTools.tsx'
import { InternationalTransfers, loadTransfers, TRANSFERS_QUERY } from './InternationalTransfers.tsx'
import { ZAPIER_SETTING } from './route.ts'
import {
  CLONING,
  GERMAN_NUMBERS,
  GermanNumbers,
  loadCloning,
  loadGermanNumbers,
  loadZapierApp,
  VoiceCloning,
  ZAPIER_APP,
  Zapier,
} from './SettingsCards.tsx'

/** A feature's state in a word or two; null while it loads. */
type State = { text: string; on: boolean } | null

type LineProps = {
  title: string
  summary: string
  help?: HelpContent
  state: State
  open: boolean
  onToggle: () => void
  children: ReactNode
}

/** One feature: its name, what it does and its state; Change opens its settings under the line, Close folds them. */
function FeatureLine({ title, summary, help, state, open, onToggle, children }: LineProps) {
  const t = useT()
  const bodyId = useId()
  return (
    <section className="k-card adm-feature" aria-label={title}>
      <div className="adm-feature-line">
        <div className="adm-feature-text">
          <b>
            {title}
            {help && <HelpTip {...helpContent(help)} />}
          </b>
          <span className="help">{summary}</span>
        </div>
        {state ? (
          <Badge tone={state.on ? 'ok' : 'neutral'}>{state.text}</Badge>
        ) : (
          <Skeleton width={72} height={20} className="sk-round" />
        )}
        <Button
          size="sm"
          variant={open ? 'ghost' : 'secondary'}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          {open ? t('admin.features.close') : t('admin.features.change')}
        </Button>
      </div>
      {open && (
        <div id={bodyId} className="adm-feature-body">
          <CardInline.Provider value={true}>{children}</CardInline.Provider>
        </div>
      )}
    </section>
  )
}

function transfersState(data: OutboundCountriesData | undefined, t: ReturnType<typeof useT>): State {
  if (!data) return null
  const { limits, countries } = data
  if (!limits.minutesPerWorkspaceDay || !limits.minutesInstallDay || !limits.transferMaxMinutes)
    return { text: t('admin.features.off'), on: false }
  if (!countries.length) return { text: t('admin.features.transfers.own'), on: true }
  return {
    text: t('admin.features.transfers.more', { count: countries.length }),
    on: true,
  }
}

function calendarState(data: CalendarToolsData | undefined, t: ReturnType<typeof useT>): State {
  if (!data) return null
  const modes = Object.values(data.modes)
  const on = modes.filter(mode => mode !== 'off').length
  return {
    text: t('admin.features.calendar.state', { on, total: modes.length }),
    on: on > 0,
  }
}

const onOff = (on: boolean | undefined, t: ReturnType<typeof useT>): State =>
  on === undefined ? null : { text: on ? t('admin.features.on') : t('admin.features.off'), on }

type FeatureId = 'transfers' | 'german' | 'cloning' | 'calendar' | 'zapier'

export function Features({ focus }: { focus?: string | null }) {
  const t = useT()
  const [open, setOpen] = useState<ReadonlySet<FeatureId>>(() => new Set(focus === ZAPIER_SETTING ? ['zapier'] : []))
  const transfers = useQuery(TRANSFERS_QUERY, loadTransfers).data
  const german = useQuery(GERMAN_NUMBERS, loadGermanNumbers).data
  const cloning = useQuery(CLONING, loadCloning).data
  const calendar = useQuery(TOOLS_QUERY, loadTools).data
  const zapier = useQuery(ZAPIER_APP, loadZapierApp).data
  const line = (id: FeatureId) => ({
    open: open.has(id),
    onToggle: () =>
      setOpen(prev => {
        const next = new Set(prev)
        if (!next.delete(id)) next.add(id)
        return next
      }),
  })
  return (
    <>
      <h3 className="adm-feature-group">{t('admin.features.group.phone')}</h3>
      <FeatureLine
        title={t('admin.system.transfers.title')}
        summary={t('admin.features.transfers.summary')}
        state={transfersState(transfers, t)}
        {...line('transfers')}
      >
        <InternationalTransfers />
      </FeatureLine>
      <FeatureLine
        title={t('admin.system.germanNumbers')}
        summary={t('admin.features.german.summary')}
        help={t('admin.system.germanNumbersHelp')}
        state={onOff(german?.on, t)}
        {...line('german')}
      >
        <GermanNumbers />
      </FeatureLine>
      <h3 className="adm-feature-group">{t('admin.features.group.voice')}</h3>
      <FeatureLine
        title={t('admin.system.cloning')}
        summary={t('admin.features.cloning.summary')}
        help={t('admin.system.cloningHelp', { brand: brandName() })}
        state={onOff(cloning?.on, t)}
        {...line('cloning')}
      >
        <VoiceCloning />
      </FeatureLine>
      <h3 className="adm-feature-group">{t('admin.features.group.integrations')}</h3>
      <FeatureLine
        title={t('admin.settings.calendarTools.title')}
        summary={t('admin.features.calendar.summary')}
        state={calendarState(calendar, t)}
        {...line('calendar')}
      >
        <Card
          description={
            <T k="admin.settings.calendarTools.help" values={{ link: appLink('#admin/providers/calendar') }} />
          }
        >
          <CalendarTools />
        </Card>
      </FeatureLine>
      <FeatureLine
        title={t('admin.system.zapier')}
        summary={t('admin.features.zapier.summary')}
        help={t('admin.system.zapierHelp')}
        state={
          zapier
            ? {
                text: zapier.url ? t('admin.features.zapier.linked') : t('admin.features.zapier.none'),
                on: !!zapier.url,
              }
            : null
        }
        {...line('zapier')}
      >
        <Zapier focused={focus === ZAPIER_SETTING} />
      </FeatureLine>
    </>
  )
}
