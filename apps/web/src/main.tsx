import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
// Fonts ship with the app: no request to a font CDN when a self-hosted install opens.
import '@fontsource/geist/400.css'
import '@fontsource/geist/500.css'
import '@fontsource/geist/600.css'
import '@fontsource/geist/700.css'
import '@fontsource/geist-mono/400.css'
import '@fontsource/geist-mono/500.css'
import './styles.css'
import './app.css'
import { captureOpenRouterReturn } from './admin/openrouterAuth.ts'
import { fetchAuthMethods } from './auth.ts'
import { startErrorReporting } from './errorReporting.ts'
import { loadBrand } from './brand.ts'
import { NewVersionBar } from './shell/NewVersionBar.tsx'
import { registerServiceWorker } from './serviceWorker.ts'
import { watchUnauthorized } from './signedOutWatch.ts'
import { installTooltips } from './ui/tooltips.ts'

// Signed out on any screen: the app goes to the sign-in page (signedOutWatch.ts, App.tsx).
watchUnauthorized()
// Sentry only when the install sends a DSN (errorReporting.ts); nothing is loaded otherwise.
void fetchAuthMethods({ attempts: 3 })
  .then(methods => startErrorReporting(methods.errorReporting))
  .catch(() => {})
installTooltips()
void loadBrand()
registerServiceWorker()

// Back from "Connect with OpenRouter": keep its answer for Admin, Providers and clear the address.
const openRouterBack = captureOpenRouterReturn(window.location.search)
if (openRouterBack) window.history.replaceState(null, '', `${window.location.pathname}${openRouterBack}`)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <NewVersionBar />
  </StrictMode>,
)
