// Providers that are failing now (LIN-111): a used-up quota, a rejected key, a model that is gone. Shown on the admin
// overview and above Admin › Providers, from the API's failure record (apps/api/src/provider-failures.ts). A
// successful test or call clears an entry; the instance admins also got one email about it (none for email itself).
import { type ProviderFailure, providerFailureReasonLabels } from '@linedesk/actions'
import { Button } from '../ui/kit.tsx'

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** "since Nov 13, 9:02 AM, 4 times": how long and how often since the last success. */
export function failingSince(failure: Pick<ProviderFailure, 'since' | 'count'>): string {
  return `since ${when(failure.since)}${failure.count > 1 ? `, ${failure.count} times` : ''}`
}

type Props = { failures: readonly ProviderFailure[]; onOpen?: () => void }

export function FailingProviders({ failures, onOpen }: Props) {
  if (!failures.length) return null
  return (
    <section className="adm-failing" role="alert" aria-label="Failing providers">
      <h2>{failures.length === 1 ? 'A provider is failing' : `${failures.length} providers are failing`}</h2>
      <ul>
        {failures.map(f => (
          <li key={f.provider}>
            <b>{f.label}</b>
            <span className="adm-failing-reason">
              {providerFailureReasonLabels[f.reason]} · {failingSince(f)}
            </span>
            <span className="adm-failing-message">{f.message}</span>
          </li>
        ))}
      </ul>
      {onOpen && (
        <Button size="sm" onClick={onOpen} title="Open Admin › Providers">
          Open Providers
        </Button>
      )}
    </section>
  )
}
