// Partner › AI keys (docs/white-label.md, S7): the partner's own speech to text, language model, voice and realtime
// accounts. Optional: without them every client call runs on this server's keys and is billed as usual. The owner
// connects a key per stage (signed in recently: the personal key step-up), it is tested at once and daily; the team
// sees the provider, the last four characters and the test, never a key. Clients are switched on one by one in
// Partner › Clients › Settings; a switched-on client's call has no usage fee when it ran fully on these keys.
import {
  PARTNER_KEY_CODES,
  PARTNER_KEY_STAGES,
  type PartnerKeyRow,
  type PartnerKeyStage,
  type PartnerKeysData,
  type ProviderName,
  partnerKeyProviders,
  providerCategoryLabel,
  providerGuide,
  providerSpec,
  type StatusState,
} from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { Logo, providerMeta } from '../admin/ProviderLogo.tsx'
import { testedAgo } from '../admin/providerStatus.ts'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { i18n } from '../i18n/index.tsx'
import { StepUpFields, StepUpSubmit, useKeyStepUp } from '../settings/account/KeyStepUp.tsx'
import { callAction } from '../settings/settings-api.ts'
import { Select } from '../ui/controls.tsx'
import { Card, Dialog, FormField, SecretInput } from '../ui/form.tsx'
import { Button, Note } from '../ui/kit.tsx'
import { Loading, SkeletonRows } from '../ui/LoadStates.tsx'
import { List, ListRow } from '../ui/list.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import { partnerErrorText } from './partner-api.ts'

export const PARTNER_KEYS_QUERY = (partnerId: string) => `partner.${partnerId}.keys`
const loadKeys = (partnerId: string) => callAction<PartnerKeysData>('partnerKeys.get', { partnerId })

/** A refusal with a partner keys code in the page's words, else the partner area's wording. */
// i18n-dynamic: team.partner.keys.error.*
export function keysErrorText(err: unknown): string {
  const code = (err as { code?: string }).code
  if (code && (PARTNER_KEY_CODES as readonly string[]).includes(code))
    return i18n().t(`team.partner.keys.error.${code}` as MessageKey)
  return partnerErrorText(err)
}

/** The mark of a stage: works, failing, not tested yet, or nothing connected. */
export const stageState = (row: PartnerKeyRow): StatusState =>
  !row.provider ? 'missing' : row.status === 'ok' ? 'works' : row.status === 'failing' ? 'failing' : 'untested'

/** The line under a stage: the provider and the key's end, and when it was tested or why it failed. */
export function stageLine(row: PartnerKeyRow, now = Date.now()): string {
  const { t } = i18n()
  if (!row.provider) return t('team.partner.keys.notConnected')
  const key = `${providerSpec(row.provider as ProviderName).label} · •••• ${row.last4 ?? ''}`
  if (row.status === 'failing' && row.failure) return `${key} · ${row.failure}`
  const tested = testedAgo(row.checkedAt, now)
  return tested ? `${key} · ${tested}` : key
}

/** The rows of the section, without data loading: also what the tests render. */
export function KeyRows({
  data,
  busy,
  onConnect,
  onTest,
  onClear,
}: {
  data: PartnerKeysData
  busy: string | null
  onConnect: (stage: PartnerKeyStage) => void
  onTest: (stage: PartnerKeyStage) => void
  onClear: (stage: PartnerKeyStage) => void
}) {
  const t = useT()
  const edit = data.canEdit && !data.disabled
  return (
    <List label={t('team.partner.keys.title')}>
      {PARTNER_KEY_STAGES.map(stage => {
        const row = data.stages.find(r => r.stage === stage) ?? emptyRow(stage)
        const name = providerCategoryLabel(stage, i18n())
        const mark = row.provider ? providerMeta[row.provider as ProviderName]?.mark : null
        return (
          <ListRow
            key={stage}
            lead={<Logo mark={mark ?? { icon: 'spark' }} size={28} />}
            title={
              <>
                <span className="k-row-text">{name}</span>
                {row.provider && <StatusMark state={stageState(row)} />}
              </>
            }
            sub={stageLine(row)}
            actions={
              edit && (
                <>
                  {row.provider && (
                    <Button
                      size="sm"
                      variant="ghost"
                      busy={busy === `test:${stage}`}
                      disabled={!!busy}
                      title={t('team.partner.keys.testTip')}
                      onClick={() => onTest(stage)}
                    >
                      {t('team.partner.keys.test')}
                    </Button>
                  )}
                  <Button size="sm" disabled={!!busy} onClick={() => onConnect(stage)}>
                    {row.provider ? t('team.partner.keys.change') : t('team.partner.keys.connect')}
                  </Button>
                  {row.provider && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="trash"
                      busy={busy === `clear:${stage}`}
                      disabled={!!busy}
                      aria-label={t('team.partner.keys.removeTip', { stage: name })}
                      title={t('team.partner.keys.removeTip', { stage: name })}
                      onClick={() => onClear(stage)}
                    />
                  )}
                </>
              )
            }
          />
        )
      })}
    </List>
  )
}

const emptyRow = (stage: PartnerKeyStage): PartnerKeyRow => ({
  stage,
  provider: null,
  last4: null,
  status: null,
  failure: null,
  checkedAt: null,
  updatedAt: null,
})

/** One line under the list: whether calls can run on the keys yet. */
export function readyLine(data: PartnerKeysData): MessageKey {
  if (data.ready.threeStage && data.ready.realtime) return msg('team.partner.keys.readyBoth')
  if (data.ready.threeStage) return msg('team.partner.keys.readyThreeStage')
  if (data.ready.realtime) return msg('team.partner.keys.readyRealtime')
  return msg('team.partner.keys.readyNone')
}

export function PartnerKeys({ partnerId, toast }: { partnerId: string; toast: (text: string) => void }) {
  const t = useT()
  const query = useQuery(PARTNER_KEYS_QUERY(partnerId), () => loadKeys(partnerId))
  const data = query.data
  const [connecting, setConnecting] = useState<PartnerKeyStage | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const store = (next: PartnerKeysData) => setQueryData(PARTNER_KEYS_QUERY(partnerId), next)

  async function run(what: string, work: () => Promise<void>) {
    if (busy) return
    setBusy(what)
    setProblem(null)
    try {
      await work()
    } catch (err) {
      setProblem(keysErrorText(err))
    } finally {
      setBusy(null)
    }
  }

  const test = (stage: PartnerKeyStage) =>
    run(`test:${stage}`, async () => {
      const { result, keys } = await callAction<{ result: { ok: boolean } | null; keys: PartnerKeysData }>(
        'partnerKeys.test',
        { partnerId, stage },
      )
      store(keys)
      toast(result?.ok ? t('team.partner.keys.works') : t('team.partner.keys.failing'))
    })

  const clear = (stage: PartnerKeyStage) =>
    run(`clear:${stage}`, async () => {
      store(await callAction<PartnerKeysData>('partnerKeys.clear', { partnerId, stage }))
      toast(t('team.partner.keys.removed', { stage: providerCategoryLabel(stage, i18n()) }))
    })

  return (
    <Card
      title={t('team.partner.keys.title')}
      description={t('team.partner.keys.description')}
      help={t('team.partner.keys.help')}
    >
      <Loading
        what={t('team.partner.keys.title')}
        loading={!data}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={<SkeletonRows rows={4} columns={2} />}
      >
        {data && (
          <>
            {data.disabled && (
              <Note tone="danger">{t('team.partner.keys.disabled', { reason: data.disabled.reason })}</Note>
            )}
            <KeyRows
              data={data}
              busy={busy}
              onConnect={setConnecting}
              onTest={stage => void test(stage)}
              onClear={stage => void clear(stage)}
            />
            {problem && (
              <Note tone="danger" role="alert">
                {problem}
              </Note>
            )}
            <p className="help">
              {t(readyLine(data))} {!data.canEdit && !data.disabled && t('team.partner.keys.ownerOnly')}
            </p>
          </>
        )}
      </Loading>
      {connecting && data && (
        <ConnectKey
          partnerId={partnerId}
          stage={connecting}
          current={data.stages.find(r => r.stage === connecting) ?? null}
          onClose={() => setConnecting(null)}
          onSaved={(next, works) => {
            store(next)
            setConnecting(null)
            toast(works ? t('team.partner.keys.connected') : t('team.partner.keys.savedFailing'))
          }}
        />
      )}
    </Card>
  )
}

/** Connect or change one stage's key: the provider, the key, how to get one; saved, then tested at once. */
function ConnectKey({
  partnerId,
  stage,
  current,
  onClose,
  onSaved,
}: {
  partnerId: string
  stage: PartnerKeyStage
  current: PartnerKeyRow | null
  onClose: () => void
  onSaved: (data: PartnerKeysData, works: boolean) => void
}) {
  const t = useT()
  const choices = partnerKeyProviders(stage)
  const [provider, setProvider] = useState<ProviderName>(
    (current?.provider as ProviderName | null) ?? choices[0] ?? ('deepgram' as ProviderName),
  )
  const [key, setKey] = useState('')
  const stepUp = useKeyStepUp(async () => {
    await callAction<PartnerKeysData>('partnerKeys.set', { partnerId, stage, provider, apiKey: key.trim() })
    const { result, keys } = await callAction<{ result: { ok: boolean } | null; keys: PartnerKeysData }>(
      'partnerKeys.test',
      { partnerId, stage },
    )
    onSaved(keys, !!result?.ok)
  }, keysErrorText)
  const guide = providerGuide(provider, i18n())
  const name = providerCategoryLabel(stage, i18n())
  return (
    <Dialog
      title={t('team.partner.keys.connectTitle', { stage: name })}
      description={t('team.partner.keys.connectDescription')}
      size="sm"
      onClose={stepUp.saving ? () => {} : onClose}
      onSubmit={e => {
        e.preventDefault()
        if (key.trim().length >= 8) stepUp.submit()
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={stepUp.saving}>
            {t('common.action.cancel')}
          </Button>
          <StepUpSubmit
            stepUp={stepUp}
            label={t('team.partner.keys.save')}
            busyLabel={t('team.partner.keys.saving')}
            disabled={key.trim().length < 8}
          />
        </>
      }
    >
      {choices.length > 1 && (
        <FormField id="partner-key-provider" label={t('team.partner.keys.provider')}>
          <Select
            id="partner-key-provider"
            label={t('team.partner.keys.provider')}
            value={provider}
            options={choices.map(p => ({ value: p, label: providerSpec(p).label }))}
            onChange={setProvider}
          />
        </FormField>
      )}
      <FormField
        id="partner-key-value"
        label={t('team.partner.keys.keyLabel', { provider: providerSpec(provider).label })}
        help={current?.provider ? t('team.partner.keys.replaceHelp') : t('team.partner.keys.keyHelp')}
        error={stepUp.error}
      >
        {/* A key, not a password: never saved as this site's login (SecretInput). */}
        <SecretInput id="partner-key-value" value={key} invalid={!!stepUp.error} onChange={setKey} />
      </FormField>
      <details className="adm-guide">
        <summary>{t('admin.providerDialog.howToGetKey')}</summary>
        <ol className="adm-guide-steps">
          {guide.steps.map(step => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className="help">
          {guide.url && (
            <>
              <a href={guide.url} target="_blank" rel="noreferrer" title={t('admin.providerDialog.opensNewTab')}>
                {t('admin.providerDialog.openProvider', { provider: providerSpec(provider).label })}
              </a>
              {' · '}
            </>
          )}
          {guide.cost}
        </p>
      </details>
      <StepUpFields
        stepUp={stepUp}
        id="partner-key-code"
        texts={{
          withEither: msg('team.partner.keys.confirmWithEither'),
          withPasskey: msg('team.partner.keys.confirmWithPasskey'),
        }}
      />
    </Dialog>
  )
}
