// A card's logo on Integrations: a brand mark the app already ships (ui/brand-logos.tsx, admin/logos.ts), one of our
// icons, or a monogram for a service whose mark we don't ship (Zapier, Make, n8n, Telnyx). Never a hotlinked image.
import { brandMarks, brandViewBox } from '../admin/logos.ts'
import { SignInMark } from '../ui/brand-logos.tsx'
import { Icon } from '../ui/kit.tsx'
import type { Mark } from './catalog.ts'

export function IntegrationMark({ mark }: { mark: Mark }) {
  return (
    <span className={mark.kind === 'monogram' ? 'ig-mark ig-mono' : 'ig-mark'} aria-hidden="true">
      {mark.kind === 'icon' ? (
        <Icon name={mark.icon} size={18} />
      ) : mark.kind === 'monogram' ? (
        mark.text
      ) : mark.brand === 'twilio' ? (
        <svg
          width={18}
          height={18}
          viewBox={brandViewBox('twilio')}
          fill="currentColor"
          focusable="false"
          aria-hidden="true"
        >
          <path d={brandMarks.twilio} />
        </svg>
      ) : (
        <SignInMark method={mark.brand} />
      )}
    </span>
  )
}
