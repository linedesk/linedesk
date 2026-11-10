import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// The API is proxied so the browser sees one origin (session cookie, no CORS).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '')
  const api = `http://localhost:${env.PORT ?? 3100}`
  return {
    plugins: [react()],
    server: { port: 5173, strictPort: true, proxy: { '/api': api, '/v1': api } },
  }
})
