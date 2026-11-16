// A card's logo on Integrations: a sign-in mark the app already ships (ui/brand-logos.tsx: the calendars), a Simple
// Icons path (admin/logos.ts) in the brand's colour, one of our icons, or a monogram where no free mark exists
// (Jobber, ServiceTitan). Never a hotlinked image.
import type { CSSProperties } from 'react'
import { brandMarks } from '../admin/logos.ts'
import { SignInMark } from '../ui/brand-logos.tsx'
import { Icon } from '../ui/kit.tsx'
import type { Mark } from './catalog.ts'

export function IntegrationMark({ mark }: { mark: Mark }) {
  if (mark.kind === 'monogram')
    return (
      <span className="ig-mark ig-mono" style={{ '--ig-mono': mark.color } as CSSProperties} aria-hidden="true">
        {mark.text}
      </span>
    )
  return (
    <span className="ig-mark" aria-hidden="true">
      {mark.kind === 'icon' ? (
        <Icon name={mark.icon} size={18} />
      ) : mark.kind === 'logo' ? (
        <svg width={18} height={18} viewBox="0 0 24 24" fill={mark.color} focusable="false" aria-hidden="true">
          <path d={brandMarks[mark.logo]} />
        </svg>
      ) : (
        <SignInMark method={mark.brand} />
      )}
    </span>
  )
}
