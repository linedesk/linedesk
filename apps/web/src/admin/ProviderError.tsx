// A provider's error, the one way every screen shows it (LIN-249): Server admin › Providers, the provider dialog and
// the install walkthrough. One short human line (providerErrorLine: a known code in plain words, else the first
// sentence, never raw JSON), cut with an ellipsis so it never widens or stretches its card; the provider's full text
// and when it happened only behind "Details".
import { useT } from '@linedesk/i18n/react'
import { cx } from '../ui/kit.tsx'
import { when } from './parts.tsx'
import { providerErrorLine } from './providerStatus.ts'

export function ProviderError({
  message,
  at = null,
  className,
}: {
  message: string
  /** When it happened (ISO); shown with the full text. */
  at?: string | null
  className?: string
}) {
  const t = useT()
  const summary = providerErrorLine(message)
  const full = message.trim()
  return (
    <span className={cx('adm-prov-error', className)}>
      <span className="adm-prov-error-line" title={summary}>
        {summary}
      </span>
      {(full !== summary || at) && (
        <details className="adm-prov-error-details">
          <summary title={t('admin.providerError.fullTip')}>{t('admin.providerError.details')}</summary>
          <span className="adm-prov-error-full">
            {at && <time dateTime={at}>{when(at)}</time>}
            {full}
          </span>
        </details>
      )}
    </span>
  )
}
