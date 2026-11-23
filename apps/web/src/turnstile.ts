// Cloudflare Turnstile on the sign-up page: its script is loaded only there, once. The CSP
// allows it (docker/Caddyfile: script-src and frame-src https://challenges.cloudflare.com).
export const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

type RenderOptions = {
  sitekey: string
  action?: string
  /** `interaction-only`: the widget shows only when Cloudflare needs the person to act; the check runs either way. */
  appearance?: 'always' | 'execute' | 'interaction-only'
  callback: (token: string) => void
  'expired-callback'?: () => void
  'error-callback'?: () => void
}
export type Turnstile = {
  render: (element: HTMLElement, options: RenderOptions) => string | undefined
  reset: (widget?: string) => void
  remove: (widget: string) => void
}

declare global {
  interface Window {
    turnstile?: Turnstile
  }
}

let loading: Promise<Turnstile> | null = null

/** The Turnstile API, loading its script the first time. */
export function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = TURNSTILE_SCRIPT
    script.async = true
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('TURNSTILE_MISSING')))
    script.onerror = () => {
      loading = null
      reject(new Error('TURNSTILE_NOT_LOADED'))
    }
    document.head.appendChild(script)
  })
  return loading
}
