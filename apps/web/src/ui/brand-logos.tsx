// Sign-in provider marks, drawn as the providers publish them. Do not recolour or redraw them.
// - Google "G": Google Identity branding guidelines for sign-in buttons
//   (developers.google.com/identity/branding-guidelines), the standard multicolour mark.
// - Microsoft logo: Microsoft identity platform sign-in branding guidelines
//   (learn.microsoft.com/entra/identity-platform/howto-add-branding-in-apps), four squares.
// - GitHub mark: GitHub logos (github.com/logos), the Octicons `mark-github` path; drawn in the text colour.
// - Cal.com, Calendly, iCloud (calendar accounts): the Simple Icons paths in admin/logos.ts, in each brand's colour
//   (Simple Icons' hex; Cal.com's is near-black, so it is drawn in the text colour). A CalDAV server that is not
//   iCloud gets a neutral calendar.

import { useT } from '@linedesk/i18n/react'
import type { ReactNode } from 'react'
import { brandMarks, brandViewBox } from '../admin/logos.ts'
import { Icon } from './kit.tsx'

const svg = (viewBox: string, children: ReactNode) => (
  <svg className="auth-logo" width="18" height="18" viewBox={viewBox} aria-hidden="true" focusable="false">
    {children}
  </svg>
)

const GoogleMark = () =>
  svg(
    '0 0 48 48',
    <>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </>,
  )

const MicrosoftMark = () =>
  svg(
    '0 0 21 21',
    <>
      <rect x="0" y="0" width="10" height="10" fill="#F25022" />
      <rect x="11" y="0" width="10" height="10" fill="#7FBA00" />
      <rect x="0" y="11" width="10" height="10" fill="#00A4EF" />
      <rect x="11" y="11" width="10" height="10" fill="#FFB900" />
    </>,
  )

const GitHubMark = () =>
  svg(
    '0 0 16 16',
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
    />,
  )

/** Our own icons for the methods without a brand: company single sign-on and a password. */
const SsoMark = () =>
  svg(
    '0 0 24 24',
    <g fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="3.5" width="16" height="17" rx="2" />
      <path d="M9 20.5v-4h6v4M8.5 8h.01M12 8h.01M15.5 8h.01M8.5 12h.01M12 12h.01M15.5 12h.01" />
    </g>,
  )

/** A person with a key, the usual sign for a passkey (our own drawing, no brand). */
const PasskeyMark = () =>
  svg(
    '0 0 24 24',
    <g fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="7.5" r="3.5" />
      <path d="M2.5 20c0-3.6 2.9-6 6.5-6 1.4 0 2.7.3 3.7.9" />
      <circle cx="17.5" cy="13.5" r="2.5" />
      <path d="M17.5 16v5M17.5 19h2" />
    </g>,
  )

const PasswordMark = () =>
  svg(
    '0 0 24 24',
    <g fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </g>,
  )

const simpleMark = (brand: 'caldotcom' | 'calendly' | 'icloud', fill: string) => () =>
  svg(brandViewBox(brand), <path fill={fill} d={brandMarks[brand]} />)

const CalendarMark = () => <Icon name="calendar" size={18} className="auth-logo" />

const marks: Record<string, () => ReactNode> = {
  google: GoogleMark,
  microsoft: MicrosoftMark,
  github: GitHubMark,
  calcom: simpleMark('caldotcom', 'currentColor'),
  calendly: simpleMark('calendly', '#006BFF'),
  icloud: simpleMark('icloud', '#3693F3'),
  caldav: CalendarMark,
  password: PasswordMark,
  passkey: PasskeyMark,
}

/** The mark for a sign-in method id; an unknown id (OIDC, named by the install) gets the building icon. */
export function SignInMark({ method }: { method: string }) {
  const Mark = marks[method] ?? SsoMark
  return <Mark />
}

type ProviderButtonProps = {
  method: string
  label: string
  lastUsed: boolean
  busy?: boolean
  /** What the button says while it runs; by default "Opening <label>…", for a provider that redirects. */
  busyText?: string
  disabled?: boolean
  onClick: () => void
}

/** A full-width "Continue with …" button: the mark on the left, "Last used" on the right when it applies. */
export function ProviderButton({ method, label, lastUsed, busy, busyText, disabled, onClick }: ProviderButtonProps) {
  const t = useT()
  return (
    <button type="button" className="k-btn k-btn-secondary auth-provider" disabled={disabled} onClick={onClick}>
      <SignInMark method={method} />
      <span className="auth-provider-label">
        {busy
          ? (busyText ?? t('auth.provider.opening', { provider: label }))
          : method === 'password'
            ? t('auth.provider.continuePassword')
            : t('auth.provider.continue', { provider: label })}
      </span>
      {lastUsed && <LastUsed />}
    </button>
  )
}

export function LastUsed() {
  const t = useT()
  return <span className="auth-last-used">{t('auth.lastUsed')}</span>
}
