import { providerAudience } from '../providerAudience.ts'
import { Note } from '../ui/kit.tsx'

/** What this install lacks, the provider group in Server admin › Providers that adds it, and the title. */
const KINDS = {
  voice: { group: 'answering', title: 'No voice provider yet', what: 'a voice' },
  calendar: { group: 'calendar', title: 'No calendar provider yet', what: 'a calendar app' },
  answering: {
    group: 'answering',
    title: "Calls aren't answered yet",
    what: 'a realtime model, or speech to text, a language model and a voice',
  },
} as const

export type MissingProviderKind = keyof typeof KINDS

/**
 * A provider this server doesn't have yet, said the same way on every settings page: a warning with the consequence as
 * its title. Server admins get the place to add it as a link; everyone else is told to ask (providerAudience.ts).
 */
export function MissingProviderNote({ kind }: { kind: MissingProviderKind }) {
  const { group, title, what } = KINDS[kind]
  return (
    <Note tone="warning" title={title}>
      {providerAudience() === 'admin' ? (
        <>
          Add {what} under{' '}
          <a className="k-link" href={`#admin/providers/${group}`}>
            Server admin › Providers
          </a>
          .
        </>
      ) : (
        'Ask your server admin.'
      )}
    </Note>
  )
}
