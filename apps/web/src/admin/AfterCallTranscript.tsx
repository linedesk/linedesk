// Server admin › Providers › After-call transcription (apps/api/src/after-call-transcript.ts): once a call's recording
// is saved, the selected provider transcribes the recording file again and the caller's lines of the transcript are
// corrected. Off until an admin selects a provider here. A provider with its own key is selected with "Use"; one whose
// service already has a key stored for an active provider (OpenAI as language model, say) with "Use <provider> key",
// which links that stored key; any other is connected with its key in its dialog (Connect), which selects it too.
// Workspace members are not told: they just see the better transcript.
import type { AfterCallTranscriptData, AfterCallTranscriptOption, ProviderName } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { useEffect, useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { Button } from '../ui/kit.tsx'
import { Loading } from '../ui/LoadStates.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import { type AdminData, runAdmin } from './api.ts'
import { Logo, providerMeta } from './ProviderLogo.tsx'

const AFTER_CALL = 'admin.afterCallTranscript'
const load = async () => (await runAdmin('afterCallTranscript.get', {})) as AfterCallTranscriptData

type Props = {
  /** The admin data: read again after a dialog saved or removed a key, so the states here are read again too. */
  data: AdminData
  onOpen: (provider: ProviderName) => void
}

export function AfterCallTranscript({ data: admin, onOpen }: Props) {
  const t = useT()
  const query = useQuery(AFTER_CALL, load)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const { reload } = query
  // A key saved, removed or selected in a provider's dialog changes what can be selected here.
  useEffect(() => {
    void admin
    void reload()
  }, [admin, reload])
  const data = query.data
  const labelOf = (name: ProviderName) => admin.providers.find(p => p.provider === name)?.label ?? name

  async function select(provider: AfterCallTranscriptOption['provider'] | null) {
    setBusy(true)
    setProblem(null)
    try {
      setQueryData(AFTER_CALL, (await runAdmin('afterCallTranscript.set', { provider })) as AfterCallTranscriptData)
    } catch (e) {
      setProblem(e instanceof Error ? e.message : t('admin.afterCallTranscript.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="adm-after-call">
      <p className="help">{t('admin.afterCallTranscript.upload')}</p>
      {data && !data.recording && (
        <p className="help adm-problem-line">{t('admin.afterCallTranscript.needsRecording')}</p>
      )}
      <Loading
        what={t('admin.afterCallTranscript.title')}
        loading={!data}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={null}
      >
        <ul className="adm-provlist">
          {data?.options.map(option => {
            const label = labelOf(option.provider)
            const connected = option.state === 'in_use' || option.state === 'connected'
            return (
              <li key={option.provider} className="adm-prov">
                <Logo mark={providerMeta[option.provider].mark} size={28} />
                <span className="adm-prov-name">
                  <b>{label}</b>
                  <span className="adm-tile-status">{option.model}</span>
                  {option.state === 'in_use' && (
                    <span className="adm-tile-status">
                      <StatusMark state="works" label={t('admin.afterCallTranscript.inUse')} />
                      {t('admin.afterCallTranscript.inUse')}
                    </span>
                  )}
                </span>
                <span className="adm-prov-actions">
                  {option.state === 'in_use' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void select(null)}
                      title={t('admin.afterCallTranscript.stopTip')}
                    >
                      {t('admin.afterCallTranscript.stop')}
                    </Button>
                  )}
                  {option.state === 'connected' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void select(option.provider)}
                      title={t('admin.afterCallTranscript.useTip', { provider: label })}
                    >
                      {t('admin.afterCallTranscript.use')}
                    </Button>
                  )}
                  {option.state === 'reusable' && option.reuseFrom && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void select(option.provider)}
                      title={t('admin.afterCallTranscript.reuseTip', { source: labelOf(option.reuseFrom) })}
                    >
                      {t('admin.afterCallTranscript.reuse', { source: labelOf(option.reuseFrom) })}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant={connected || option.state === 'reusable' ? 'ghost' : 'secondary'}
                    onClick={() => onOpen(option.provider)}
                    title={
                      connected
                        ? t('admin.providers.editTip', { provider: label })
                        : t('admin.providers.connectTip', { provider: label })
                    }
                  >
                    {connected ? t('admin.providers.edit') : t('admin.providers.connect')}
                  </Button>
                </span>
              </li>
            )
          })}
        </ul>
      </Loading>
      {problem && (
        <p className="k-field-msg" role="alert">
          {problem}
        </p>
      )}
    </div>
  )
}
