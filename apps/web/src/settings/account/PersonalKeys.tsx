// Account settings, Personal API keys (LIN-339): keys a person makes for themselves, for the `linedesk` CLI, MCP
// clients and scripts. A key acts as its maker does (every workspace, their role there), so it lives on the Account
// page, not in a workspace's Developers settings. Made, listed and revoked only signed in as yourself (the server
// refuses keys and support access); the key is shown once with Copy, revoking asks first.
import type { PersonalKeyCreated, PersonalKeyListData, PersonalKeySummary } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { type FormEvent, useState } from 'react'
import { passkeySupported } from '../../auth.ts'
import { checkAuthenticator } from '../../authenticator-api.ts'
import { brandName } from '../../brand.ts'
import { setQueryData, useQuery } from '../../cachedQuery.ts'
import { fmt } from '../../i18n/format.ts'
import { signInAgain } from '../../localData.ts'
import { AuthError } from '../../ui/AuthError.tsx'
import { Dialog, Input } from '../../ui/form.tsx'
import { Badge, Button } from '../../ui/kit.tsx'
import { List, ListEmpty, ListRow } from '../../ui/list.tsx'
import { Loading, SkeletonList } from '../../ui/LoadStates.tsx'
import { Field, Section } from '../fields.tsx'
import { callAction, readAction } from '../settings-api.ts'
import { confirmWithPasskey } from './account-api.ts'
import { authenticatorErrorText } from './authenticator.tsx'
import '../../integrations/developers.css'

const KEYS = 'personalKey.list'
const loadKeys = () => readAction<PersonalKeyListData>(KEYS)
const day = (iso: string) => fmt().dateTime(new Date(iso), { month: 'short', day: 'numeric', year: 'numeric' })

export function PersonalKeys() {
  const t = useT()
  const keys = useQuery(KEYS, loadKeys, { persist: true })
  const [creating, setCreating] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const active = keys.data?.keys.filter(k => !k.revoked_at) ?? []
  return (
    <Section
      id="ac-api-keys"
      title={t('account.nav.apiKeys.label')}
      help={t('account.apiKeys.help', { cli: 'linedesk login --url', origin: window.location.origin, mcp: '/mcp' })}
      actions={
        <Button size="sm" icon="plus" onClick={() => setCreating(true)}>
          {t('account.apiKeys.create')}
        </Button>
      }
    >
      <Loading
        what={t('account.nav.apiKeys.label')}
        loading={keys.data === undefined}
        error={keys.error}
        onRetry={() => void keys.reload()}
        skeleton={<SkeletonList rows={1} aside action />}
      >
        {active.length === 0 ? (
          <ListEmpty>{t('account.apiKeys.empty')}</ListEmpty>
        ) : (
          <List label={t('account.nav.apiKeys.label')}>
            {active.map(k => (
              <KeyRow key={k.id} personalKey={k} onDone={setStatus} />
            ))}
          </List>
        )}
      </Loading>
      {status && (
        <p className="help" role="status">
          {status}
        </p>
      )}
      {creating && <CreateKey onClose={() => setCreating(false)} />}
    </Section>
  )
}

function KeyRow({ personalKey, onDone }: { personalKey: PersonalKeySummary; onDone: (text: string) => void }) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  /** Revoke asks once in place (click again), like a workspace API key: no browser dialog. */
  const [confirming, setConfirming] = useState(false)
  async function revoke() {
    if (!confirming) return setConfirming(true)
    setBusy(true)
    try {
      await callAction('personalKey.revoke', { personalKeyId: personalKey.id })
      setQueryData<PersonalKeyListData | undefined>(
        KEYS,
        d => d && { keys: d.keys.filter(k => k.id !== personalKey.id) },
        { persist: true },
      )
      onDone(t('account.apiKeys.revoked', { name: personalKey.name }))
    } catch (e) {
      onDone((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <ListRow
      title={personalKey.name}
      sub={
        <>
          <code className="dev-prefix">{personalKey.prefix}…</code> ·{' '}
          {personalKey.last_used_at
            ? t('settings.developers.usedOn', {
                created: day(personalKey.created_at),
                used: day(personalKey.last_used_at),
              })
            : t('settings.developers.neverUsed', { created: day(personalKey.created_at) })}
        </>
      }
      aside={
        personalKey.admin_until &&
        Date.parse(personalKey.admin_until) > Date.now() && (
          <Badge tone="outline" title={t('account.apiKeys.serverAdminTip', { until: day(personalKey.admin_until) })}>
            {t('account.apiKeys.serverAdmin')}
          </Badge>
        )
      }
      actions={
        <Button
          size="sm"
          variant={confirming ? 'danger' : 'ghost'}
          disabled={busy}
          onClick={revoke}
          onBlur={() => setConfirming(false)}
          title={
            confirming
              ? t('account.apiKeys.revokeConfirmTip')
              : t('settings.developers.revokeTip', { name: personalKey.name })
          }
        >
          {confirming ? t('settings.developers.revokeKey') : t('settings.developers.revoke')}
        </Button>
      }
    />
  )
}

function CreateKey({ onClose }: { onClose: () => void }) {
  const t = useT()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [created, setCreated] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  // Making a key needs a sign-in from the last 10 minutes (the server's SIGN_IN_AGAIN), or, with a passkey, a passkey
  // or authenticator confirmation from the last 10 minutes, asked for here (PASSKEY_STEP_UP_REQUIRED).
  const [signInFirst, setSignInFirst] = useState(false)
  const [confirm, setConfirm] = useState<{ authenticator: boolean } | null>(null)
  const [code, setCode] = useState('')

  async function create() {
    setError(null)
    setSignInFirst(false)
    try {
      const result = await callAction<PersonalKeyCreated>('personalKey.create', { name: name.trim() })
      setCreated(result.key)
      // The row as the server has it (passkey_confirmed is for the server to say), shown before the dialog closes.
      void loadKeys()
        .then(d => setQueryData<PersonalKeyListData | undefined>(KEYS, d, { persist: true }))
        .catch(() => {})
    } catch (err) {
      const { code: refusal, authenticator } = err as { code?: unknown; authenticator?: unknown }
      if (refusal === 'SIGN_IN_AGAIN') setSignInFirst(true)
      else if (refusal === 'PASSKEY_STEP_UP_REQUIRED') setConfirm({ authenticator: authenticator === true })
      else setError((err as Error).message)
    }
  }

  /** Runs one step (a confirmation, then the create) with the dialog busy. */
  async function busyWith(work: () => Promise<void>) {
    setSaving(true)
    try {
      await work()
    } finally {
      setSaving(false)
    }
  }

  // confirmWithPasskey: another account's passkey signs out instead of making a key for that account.
  const withPasskey = () =>
    busyWith(async () => {
      setError(null)
      try {
        await confirmWithPasskey()
      } catch (err) {
        return setError((err as Error).message)
      }
      await create()
    })

  function submit(e: FormEvent) {
    e.preventDefault()
    if (saving) return
    const typed = code.trim()
    if (confirm && !typed) return void withPasskey()
    if (!confirm) return void busyWith(create)
    void busyWith(async () => {
      setError(null)
      try {
        await checkAuthenticator(typed)
      } catch (err) {
        return setError(authenticatorErrorText(err, t))
      }
      setCode('')
      await create()
    })
  }

  if (created)
    return (
      <Dialog
        key="created" // a new dialog, so focus moves into it (Esc, Tab)
        title={t('account.apiKeys.created.title')}
        description={t('settings.developers.created.description')}
        onClose={onClose}
        footer={
          <Button variant="primary" onClick={onClose}>
            {t('settings.developers.created.done')}
          </Button>
        }
      >
        <div className="dev-secret">
          <Input
            readOnly
            value={created}
            aria-label={t('settings.developers.created.key')}
            onFocus={e => e.currentTarget.select()}
          />
          <Button
            onClick={() =>
              navigator.clipboard.writeText(created).then(
                () => setCopied(t('settings.developers.created.copied')),
                () => setCopied(t('settings.developers.created.copyFailed')),
              )
            }
          >
            {t('common.copy.copy')}
          </Button>
        </div>
        {copied && (
          <p className="help" role="status">
            {copied}
          </p>
        )}
      </Dialog>
    )

  return (
    <Dialog
      title={t('account.apiKeys.dialog.title')}
      description={t('account.apiKeys.dialog.description')}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{t('common.action.cancel')}</Button>
          {signInFirst ? (
            <Button variant="primary" title={t('account.signInAgain.title')} onClick={() => void signInAgain()}>
              {t('account.signInAgain.button')}
            </Button>
          ) : confirm && !code.trim() ? (
            <Button
              busy={saving}
              variant="primary"
              type="submit"
              disabled={saving || !name.trim() || !passkeySupported()}
              title={t('admin.stepUp.confirm.tip')}
            >
              {saving ? t('admin.stepUp.waiting') : t('admin.stepUp.confirm.button')}
            </Button>
          ) : confirm ? (
            <Button busy={saving} type="submit" variant="primary" disabled={saving || !name.trim()}>
              {t('account.apiKeys.confirm.withCode')}
            </Button>
          ) : (
            <Button busy={saving} type="submit" variant="primary" disabled={saving || !name.trim()}>
              {saving ? t('settings.developers.dialog.creating') : t('settings.developers.dialog.create')}
            </Button>
          )}
        </>
      }
    >
      <Field
        id="ac-key-name"
        label={t('settings.developers.dialog.name')}
        error={signInFirst ? t('account.apiKeys.signInFirst') : error}
      >
        <Input
          id="ac-key-name"
          maxLength={60}
          placeholder={t('account.apiKeys.dialog.namePlaceholder')}
          value={name}
          invalid={Boolean(error)}
          onChange={e => setName(e.target.value)}
        />
      </Field>
      {confirm && (
        <p className="help" role="status">
          {t(confirm.authenticator ? 'account.apiKeys.confirm.withEither' : 'account.apiKeys.confirm.withPasskey')}
        </p>
      )}
      {confirm && !passkeySupported() && <AuthError message={t('admin.stepUp.httpsNeeded', { brand: brandName() })} />}
      {confirm?.authenticator && (
        <Field id="ac-key-code" label={t('account.authenticator.code')}>
          <Input
            id="ac-key-code"
            placeholder={t('account.authenticator.codePlaceholder')}
            value={code}
            onChange={e => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            disabled={saving}
          />
        </Field>
      )}
    </Dialog>
  )
}
