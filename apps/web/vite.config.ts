import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// The API is proxied so the browser sees one origin (session cookie, no CORS).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '')
  const api = `http://localhost:${env.PORT ?? 3100}`
  return {
    plugins: [react()],
    // The build's version: when it changes (a new deploy), the local store loads every table afresh.
    define: { 'import.meta.env.VITE_APP_BUILD': JSON.stringify(env.APP_BUILD || new Date().toISOString()) },
    server: { port: 5173, strictPort: true, proxy: { '/api': api, '/v1': api } },
  }
})
