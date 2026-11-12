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
import { loadBrand } from './brand.ts'
import { registerServiceWorker } from './serviceWorker.ts'
import { installTooltips } from './ui/tooltips.ts'

installTooltips()
void loadBrand()
registerServiceWorker()

// Back from "Connect with OpenRouter": keep its answer for Admin, Providers and clear the address.
const openRouterBack = captureOpenRouterReturn(window.location.search)
if (openRouterBack) window.history.replaceState(null, '', `${window.location.pathname}${openRouterBack}`)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
