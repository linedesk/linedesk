// Server admin › System › Sign-up countries (packages/actions/src/signup-access.ts): per country the install can serve,
// who may sign up there: everyone, only invited email addresses, or nobody. The US, Canada and Puerto Rico are open by
// default; Germany for invited addresses by default (whether German numbers can be bought yet does not matter here). One invite list for every country set to "only invited". Each change saves at once and is audited.
import { normalizeInviteEmail, phoneCountryName, type SignupAccessData, type SignupMode } from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { i18n } from '../i18n/index.tsx'
import { Select } from '../ui/controls.tsx'
import { Card, Input } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import { Loading, Skeleton } from '../ui/LoadStates.tsx'
import { runAdmin } from './api.ts'

const SIGNUP_ACCESS = 'admin.signupAccess'
const load = async () => (await runAdmin('signupAccess.get', {})) as SignupAccessData
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MODE_NAMES: Record<SignupMode, MessageKey> = {
  open: msg('admin.system.signupAccess.mode.open'),
  invited: msg('admin.system.signupAccess.mode.invited'),
  off: msg('admin.system.signupAccess.mode.off'),
}

export function SignupAccess() {
  const t = useT()
  const query = useQuery(SIGNUP_ACCESS, load)
  const data = query.data
  const [typed, setTyped] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const modes = (Object.keys(MODE_NAMES) as SignupMode[]).map(value => ({ value, label: t(MODE_NAMES[value]) }))
  const inviting = !!data?.countries.some(c => c.mode === 'invited')

  async function save(change: { modes?: Record<string, SignupMode>; invites?: string[] }) {
    if (!data) return
    setProblem(null)
    const shown: SignupAccessData = {
      countries: data.countries.map(c => ({ ...c, mode: change.modes?.[c.country] ?? c.mode })),
      invites: change.invites ?? data.invites,
    }
    setQueryData<SignupAccessData | undefined>(SIGNUP_ACCESS, shown)
    try {
      setQueryData<SignupAccessData | undefined>(
        SIGNUP_ACCESS,
        (await runAdmin('signupAccess.set', change)) as SignupAccessData,
      )
    } catch (e) {
      setQueryData<SignupAccessData | undefined>(SIGNUP_ACCESS, data)
      setProblem(e instanceof Error ? e.message : t('admin.system.signupAccess.failed'))
    }
  }
  function invite() {
    if (!data) return
    const email = normalizeInviteEmail(typed)
    if (!EMAIL.test(email)) return setProblem(t('admin.system.signupAccess.badEmail'))
    setTyped('')
    if (data.invites.includes(email)) return
    void save({ invites: [...data.invites, email].sort() })
  }

  return (
    <Card
      title={t('admin.system.signupAccess.title')}
      description={t('admin.system.signupAccess.description')}
      help={t('admin.system.signupAccess.help')}
    >
      <Loading
        what={t('admin.system.signupAccess.title')}
        loading={!data}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={<Skeleton shape="text" width={260} />}
      >
        {data && (
          <>
            <ul className="adm-access-countries">
              {data.countries.map(c => {
                const name = phoneCountryName(c.country, i18n())
                return (
                  <li key={c.country}>
                    <span>{name}</span>
                    <Select
                      size="sm"
                      align="end"
                      value={c.mode}
                      options={modes}
                      label={t('admin.system.signupAccess.modeOf', { country: name })}
                      onChange={mode => void save({ modes: { [c.country]: mode } })}
                    />
                  </li>
                )
              })}
            </ul>
            {inviting && (
              <div className="adm-access-invites">
                <b>{t('admin.system.signupAccess.invites')}</b>
                <span className="help">{t('admin.system.signupAccess.invitesHelp')}</span>
                <form
                  className="adm-access-add"
                  onSubmit={e => {
                    e.preventDefault()
                    invite()
                  }}
                >
                  <Input
                    type="email"
                    value={typed}
                    aria-label={t('admin.system.signupAccess.email')}
                    placeholder={t('admin.system.signupAccess.email')}
                    onChange={e => {
                      setTyped(e.target.value)
                      setProblem(null)
                    }}
                  />
                  <Button type="submit" disabled={!typed.trim()}>
                    {t('admin.system.signupAccess.add')}
                  </Button>
                </form>
                {data.invites.length ? (
                  <ul className="adm-access-list">
                    {data.invites.map(email => (
                      <li key={email}>
                        <span>{email}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void save({ invites: data.invites.filter(e => e !== email) })}
                        >
                          {t('admin.system.signupAccess.remove')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="help">{t('admin.system.signupAccess.noInvites')}</p>
                )}
              </div>
            )}
            {problem && (
              <p className="k-field-msg" role="alert">
                {problem}
              </p>
            )}
          </>
        )}
      </Loading>
    </Card>
  )
}
