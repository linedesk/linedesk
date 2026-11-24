// Server admin › Call quality › After-call transcription (apps/api/src/after-call-transcript.ts): once a call's recording
// is saved, the picked service transcribes the recording file again and the caller's lines of the transcript are
// corrected. A feature, not a provider: each service is connected once under Providers (speech to text,
// language model or voice) and this only picks which connected one transcribes, with that key. A service that is not
// connected links to its provider. Off until an admin picks one. Workspace members just see the better transcript.
import {
  type AfterCallTranscriptData,
  type AfterCallTranscriptOption,
  type ProviderName,
  providerCategoryLabel,
  providerSpec,
  type TranscriptService,
  transcriptServiceLabels,
} from '@linedesk/actions'
import { i18n } from '../i18n/index.tsx'
import { T, useT } from '@linedesk/i18n/react'
import { useEffect, useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { appLink } from '../ui/AppLink.tsx'
import { Button } from '../ui/kit.tsx'
import { Loading } from '../ui/LoadStates.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import { type AdminData, runAdmin } from './api.ts'
import { Logo, providerMeta } from './ProviderLogo.tsx'

const AFTER_CALL = 'admin.afterCallTranscript'
/** ElevenLabs with only the voice's key: that key may not have Speech to Text permission. */
const voiceOnlyElevenLabs = (option: AfterCallTranscriptOption) =>
  option.service === 'elevenlabs' && option.keyFrom === 'elevenlabs'
const load = async () => (await runAdmin('afterCallTranscript.get', {})) as AfterCallTranscriptData

type Props = {
  /** The admin data: read again after a key was saved or removed, so the states here are read again too. */
  data: AdminData
}

export function AfterCallTranscript({ data: admin }: Props) {
  const t = useT()
  const query = useQuery(AFTER_CALL, load)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const { reload } = query
  // A key saved or removed under Providers changes which services are connected.
  useEffect(() => {
    void admin
    void reload()
  }, [admin, reload])
  const data = query.data
  const labelOf = (name: ProviderName) => admin.providers.find(p => p.provider === name)?.label ?? name

  async function pick(service: TranscriptService | null) {
    setBusy(true)
    setProblem(null)
    try {
      setQueryData(AFTER_CALL, (await runAdmin('afterCallTranscript.set', { service })) as AfterCallTranscriptData)
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
        <p className="help adm-problem-line">
          <T k="admin.afterCallTranscript.needsRecording" values={{ link: appLink('#admin/providers/recording') }} />
        </p>
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
            const service = transcriptServiceLabels[option.service]
            return (
              <li key={option.service} className="adm-prov">
                <Logo mark={providerMeta[option.connectAt].mark} size={28} />
                <span className="adm-prov-name">
                  <b>{service}</b>
                  <span className="adm-tile-status">{option.model}</span>
                  {option.state === 'in_use' && (
                    <span className="adm-tile-status">
                      <StatusMark state="works" label={t('admin.afterCallTranscript.inUse')} />
                      {t('admin.afterCallTranscript.inUse')}
                    </span>
                  )}
                  {option.keyFrom &&
                    (voiceOnlyElevenLabs(option) ? (
                      // A key made for the voice may lack Speech to Text: ElevenLabs then refuses (401) and the live
                      // transcript stays. Said before it is picked, not found out from calls.
                      <span className="adm-tile-status" title={t('admin.afterCallTranscript.voiceKeyTip')}>
                        {t('admin.afterCallTranscript.voiceKey')}
                      </span>
                    ) : (
                      <span className="adm-tile-status">
                        {t('admin.afterCallTranscript.keyFrom', {
                          category: providerCategoryLabel(providerSpec(option.keyFrom).category, i18n()),
                        })}
                      </span>
                    ))}
                </span>
                <span className="adm-prov-actions">
                  {option.state === 'in_use' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void pick(null)}
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
                      onClick={() => void pick(option.service)}
                      title={t('admin.afterCallTranscript.useTip', { service })}
                    >
                      {t('admin.afterCallTranscript.use')}
                    </Button>
                  )}
                  {option.state === 'none' && (
                    <span className="help">
                      <T
                        k="admin.afterCallTranscript.connectFirst"
                        values={{
                          service,
                          link: appLink(`#admin/providers/${option.connectAt}`, {
                            title: t('admin.providers.connectTip', { provider: labelOf(option.connectAt) }),
                          }),
                        }}
                      />
                    </span>
                  )}
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
