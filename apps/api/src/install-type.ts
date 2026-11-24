// How this server is installed (Linedesk Cloud, the Docker image, pnpm dev): told in setup reports
// (setup-feedback.ts) and used by Server admin's status card to say how to start the voice agent.

/** Linedesk Cloud's address. */
const CLOUD_HOST = 'app.linedesk.ai'
export type InstallType = 'docker' | 'dev' | 'cloud' | 'unknown'

/** How this server is installed: Linedesk Cloud, the Docker image (docker/api-entrypoint.sh says so), or pnpm dev. */
export function installType(env: Record<string, string | undefined> = process.env): InstallType {
  try {
    if (new URL(env.PUBLIC_URL ?? '').host === CLOUD_HOST) return 'cloud'
  } catch {}
  if (env.LINEDESK_INSTALL_TYPE === 'docker') return 'docker'
  if (env.NODE_ENV !== 'production') return 'dev'
  return 'unknown'
}
