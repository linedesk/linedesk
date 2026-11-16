import { T, useT } from '@linedesk/i18n/react'
import { appLink } from '../ui/AppLink.tsx'
import { providerAudience } from '../providerAudience.ts'
import { Note } from '../ui/kit.tsx'

/** What this install lacks and the provider group in Server admin › Providers that adds it (texts: settings.missingProvider.<kind>.*). */
const KINDS = {
  voice: { group: 'answering' },
  calendar: { group: 'calendar' },
  answering: { group: 'answering' },
  // Call emails (Settings › Assistant): without a language model every call email goes to everyone with them on.
  emailRouting: { group: 'answering' },
} as const

export type MissingProviderKind = keyof typeof KINDS

/**
 * A provider this server doesn't have yet, said the same way on every settings page: a warning with the consequence as
 * its title. Server admins get the place to add it as a link; everyone else is told to ask (providerAudience.ts).
 */
export function MissingProviderNote({ kind }: { kind: MissingProviderKind }) {
  const t = useT()
  const { group } = KINDS[kind]
  // i18n-dynamic: settings.missingProvider.*
  return (
    <Note tone="warning" title={t(`settings.missingProvider.${kind}.title`)}>
      {providerAudience() === 'admin' ? (
        <T
          k={`settings.missingProvider.${kind}.add`}
          values={{
            link: appLink(`#admin/providers/${group}`),
          }}
        />
      ) : (
        t('settings.missingProvider.ask')
      )}
    </Note>
  )
}
