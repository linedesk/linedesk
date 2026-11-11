// Registers the service worker (public/sw.js): installable app, app shell offline. The build's
// version is in the script URL, so every deploy installs a fresh worker with its own shell cache.
export const serviceWorkerSupported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator

export const serviceWorkerUrl = (build: string) => `/sw.js?build=${encodeURIComponent(build)}`

export function registerServiceWorker(build: string = import.meta.env.VITE_APP_BUILD ?? 'dev') {
  if (!serviceWorkerSupported()) return
  navigator.serviceWorker.register(serviceWorkerUrl(build), { scope: '/' }).catch(error => {
    // Not fatal: the app works without it, only installing and opening offline don't.
    console.warn('service worker not registered:', error)
  })
}
