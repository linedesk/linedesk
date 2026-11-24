// Server admin › Features › International transfers: the countries every workspace's transfers (and forwarding checks)
// may call through this server's carrier account besides the countries of its own numbers (outboundCountries.get/.set,
// packages/actions/src/outbound.ts). Countries are picked by name with their flag and shown as chips; each add or
// remove saves at once, like the other System cards. A frequent toll-fraud destination is saved only after a second,
// explicit Allow. Under it: the last 24 hours and the minute limits (set in the server's env), one short row each.
import { countryList, type OutboundCountriesData, phoneCountryName } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { useMemo, useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { fmt } from '../i18n/format.ts'
import { i18n } from '../i18n/index.tsx'
import { searchCountries } from '../settings/workspaceLocaleModel.ts'
import { Card } from '../ui/form.tsx'
import { Button, Icon, Note } from '../ui/kit.tsx'
import { Loading, Skeleton } from '../ui/LoadStates.tsx'
import { flagOf, phoneCountryOptions } from '../ui/phoneInputModel.ts'
import { type SearchOption, SearchSelect } from '../ui/SearchSelect.tsx'
import { runAdmin } from './api.ts'

const KEY = 'admin.outboundCountries'
const load = async () => (await runAdmin('outboundCountries.get', {})) as OutboundCountriesData

/** The countries that can still be added: every country of the phone field but the ones already allowed. */
export function addableCountries(allowed: readonly string[]): SearchOption[] {
  return phoneCountryOptions()
    .filter(o => !allowed.includes(o.value))
    .map(o => ({ value: o.value, label: o.name, icon: o.flag, meta: o.value, ...(o.group ? { group: o.group } : {}) }))
}

type Row = { label: string; value: string }

/**
 * The stat rows under the countries: the last 24 hours, then the limits (one row each), or one row saying transfers
 * are off when a limit is 0. The minutes through this server's carrier account get their own row only when they
 * differ from all minutes (some workspaces use their own carrier account).
 */
export function transferStats(data: Pick<OutboundCountriesData, 'usage' | 'limits'>): Row[] {
  const t = i18n().t
  const { usage, limits } = data
  const rows: Row[] = [
    {
      label: t('admin.system.transfers.last24h'),
      value: t('admin.system.transfers.usage', {
        transfers: usage.transfers,
        minutes: usage.transferMinutes,
        checks: usage.forwardingChecks,
      }),
    },
  ]
  if (usage.installTransferMinutes !== usage.transferMinutes)
    rows.push({
      label: t('admin.system.transfers.onServerAccount'),
      value: t('admin.system.transfers.minutes', { minutes: usage.installTransferMinutes }),
    })
  if (!limits.minutesPerWorkspaceDay || !limits.minutesInstallDay || !limits.transferMaxMinutes) {
    rows.push({ label: t('admin.system.limits'), value: t('admin.system.transfersOff') })
    return rows
  }
  rows.push(
    {
      label: t('admin.system.transfers.perWorkspace'),
      value: t('admin.system.transfers.perDay', { minutes: limits.minutesPerWorkspaceDay }),
    },
    {
      label: t('admin.system.transfers.perServer'),
      value: t('admin.system.transfers.perDay', { minutes: limits.minutesInstallDay }),
    },
    {
      label: t('admin.system.transfers.perCall'),
      value: t('admin.system.transfers.minutes', { minutes: limits.transferMaxMinutes }),
    },
  )
  return rows
}

export function InternationalTransfers() {
  const t = useT()
  const query = useQuery(KEY, load)
  const data = query.data ?? null
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  /** A frequent toll-fraud destination that was picked: saved only once it is allowed a second time. */
  const [risky, setRisky] = useState<string | null>(null)
  const countries = data?.countries ?? []
  const options = useMemo(() => addableCountries(countries), [countries])
  const name = (country: string) => phoneCountryName(country, i18n())
  const editable = !!data && !data.fromEnv

  async function save(next: string[], confirmHighRisk?: string[]) {
    if (!data) return
    setProblem(null)
    setBusy(true)
    setQueryData<OutboundCountriesData | undefined>(KEY, { ...data, countries: [...next].sort() })
    try {
      const saved = (await runAdmin('outboundCountries.set', {
        countries: next,
        ...(confirmHighRisk ? { confirmHighRisk } : {}),
      })) as OutboundCountriesData
      setQueryData<OutboundCountriesData | undefined>(KEY, saved)
    } catch (e) {
      setQueryData<OutboundCountriesData | undefined>(KEY, data)
      setProblem(e instanceof Error ? e.message : t('admin.system.transfers.failed'))
    } finally {
      setBusy(false)
    }
  }

  function add(country: string) {
    if (!data || !country) return
    if (data.highRisk.includes(country)) {
      setRisky(country)
      return
    }
    setRisky(null)
    void save([...countries, country])
  }

  return (
    <Card
      title={t('admin.system.transfers.title')}
      description={t('admin.system.transfers.description')}
      help={t('admin.system.transfers.help')}
    >
      <Loading
        what={t('admin.system.transfers.what')}
        loading={!data}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={<Skeleton shape="text" width={240} />}
      >
        {data && (
          <>
            <div className="adm-countries">
              <span className="adm-countries-label" id="adm-countries-label">
                {t('admin.system.transfers.allowed')}
              </span>
              <div className="adm-chips" role="group" aria-labelledby="adm-countries-label">
                {countries.map(country => (
                  <span key={country} className="adm-chip">
                    <span aria-hidden>{flagOf(country)}</span>
                    {name(country)}
                    {editable && (
                      <button
                        type="button"
                        className="adm-chip-x"
                        disabled={busy}
                        title={t('admin.system.transfers.remove', { country: name(country) })}
                        aria-label={t('admin.system.transfers.remove', { country: name(country) })}
                        onClick={() => void save(countries.filter(c => c !== country))}
                      >
                        <Icon name="close" size={12} />
                      </button>
                    )}
                  </span>
                ))}
                {!countries.length && <span className="adm-chips-empty">{t('admin.system.transfers.onlyOwn')}</span>}
                {editable && (
                  <span className="adm-chips-add">
                    <SearchSelect
                      id="adm-countries-add"
                      value=""
                      options={options}
                      search={searchCountries}
                      label={t('admin.system.transfers.add')}
                      empty={t('admin.system.transfers.add')}
                      placeholder={t('admin.system.transfers.search')}
                      disabled={busy}
                      onChange={add}
                    />
                  </span>
                )}
              </div>
            </div>
            {data.fromEnv && <p className="help">{t('admin.system.fromEnv', { env: 'OUTBOUND_COUNTRIES' })}</p>}
            {risky && editable && (
              <Note tone="danger">
                {t('admin.system.riskyWarning', { count: 1, countries: countryList([risky], i18n()) })}
                <span className="adm-risky-actions">
                  <Button
                    size="sm"
                    variant="danger"
                    busy={busy}
                    onClick={() => {
                      const country = risky
                      setRisky(null)
                      void save([...countries, country], [country])
                    }}
                  >
                    {t('admin.system.transfers.riskyAllow', { country: name(risky) })}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRisky(null)}>
                    {t('common.action.cancel')}
                  </Button>
                </span>
              </Note>
            )}
            {problem && (
              <p className="k-field-msg" role="alert">
                {problem}
              </p>
            )}
            {data.twilioBlocked?.length ? (
              <Note tone="warning">
                {t('admin.system.twilioBlocked', {
                  countries: countryList(data.twilioBlocked, i18n()),
                  names: fmt().list(data.twilioBlocked.map(name), { type: 'unit', style: 'short' }),
                })}
              </Note>
            ) : null}
            {data.spendCapsUnconfirmed?.length ? (
              <Note tone="warning">
                {t('admin.system.spendCapsUnconfirmed', {
                  count: data.spendCapsUnconfirmed.length,
                  profiles: fmt().list(
                    data.spendCapsUnconfirmed.map(p => p.profile),
                    { type: 'unit', style: 'short' },
                  ),
                })}
              </Note>
            ) : null}
            <dl className="adm-facts adm-transfer-stats">
              {transferStats(data).map(row => (
                <div key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </Loading>
    </Card>
  )
}
