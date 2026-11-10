import { describe, expect, it } from 'vitest'
import { readAuthConfig } from './auth-methods.ts'

describe('readAuthConfig', () => {
  it('offers only the password with no env set', () => {
    expect(readAuthConfig({}).methods).toEqual({ password: true, magicLink: false, signUp: true, sso: [] })
  })

  it('offers the email link with SMTP, or with log delivery when asked for, whatever NODE_ENV says', () => {
    expect(readAuthConfig({ SMTP_URL: 'smtp://mail.example.com' }).methods.magicLink).toBe(true)
    expect(readAuthConfig({ EMAIL_TO_LOG: 'true' }).methods.magicLink).toBe(true)
    expect(readAuthConfig({ NODE_ENV: 'development' }).methods.magicLink).toBe(false)
    expect(readAuthConfig({ EMAIL_TO_LOG: 'yes' }).methods.magicLink).toBe(false)
  })

  it('turns the password off only with AUTH_PASSWORD_ENABLED=false', () => {
    expect(readAuthConfig({ AUTH_PASSWORD_ENABLED: 'false' }).methods.password).toBe(false)
    expect(readAuthConfig({ AUTH_PASSWORD_ENABLED: 'true' }).methods.password).toBe(true)
  })

  it('lists a provider only when both its id and secret are set', () => {
    expect(readAuthConfig({ GOOGLE_CLIENT_ID: 'id' }).methods.sso).toEqual([])
    const config = readAuthConfig({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's', MICROSOFT_CLIENT_ID: 'id', MICROSOFT_CLIENT_SECRET: 's' })
    expect(config.methods.sso).toEqual([{ id: 'google', label: 'Google' }, { id: 'microsoft', label: 'Microsoft' }])
    expect(config.microsoft?.tenantId).toBe('common')
  })

  it('needs a discovery URL for OpenID Connect and uses the display name', () => {
    const keys = { OIDC_CLIENT_ID: 'id', OIDC_CLIENT_SECRET: 's' }
    expect(readAuthConfig(keys).oidc).toBeNull()
    const url = 'https://id.example.com/.well-known/openid-configuration'
    expect(readAuthConfig({ ...keys, OIDC_DISCOVERY_URL: url }).methods.sso).toEqual([{ id: 'oidc', label: 'Single sign-on' }])
    expect(readAuthConfig({ ...keys, OIDC_DISCOVERY_URL: url, OIDC_DISPLAY_NAME: 'Okta' }).methods.sso[0]?.label).toBe('Okta')
  })

  it('never exposes secrets in the public methods', () => {
    const { methods } = readAuthConfig({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'top-secret' })
    expect(JSON.stringify(methods)).not.toContain('top-secret')
  })

  describe('providers trusted to join an account by email', () => {
    const microsoft = { MICROSOFT_CLIENT_ID: 'id', MICROSOFT_CLIENT_SECRET: 's' }

    it('trusts Google', () => {
      expect(readAuthConfig({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's' }).trustedProviders).toEqual(['google'])
    })

    it.each([undefined, 'common', 'organizations', 'consumers', 'Common'])('does not trust Microsoft on the shared tenant %s', tenant => {
      expect(readAuthConfig({ ...microsoft, MICROSOFT_TENANT_ID: tenant }).trustedProviders).toEqual([])
    })

    it('trusts Microsoft when the app is limited to one tenant', () => {
      expect(readAuthConfig({ ...microsoft, MICROSOFT_TENANT_ID: '6f2c1d4e-0b7a-4a55-9c0e-2a4d5b8e1f30' }).trustedProviders).toEqual(['microsoft'])
    })

    it('never trusts the generic OpenID Connect provider', () => {
      const oidc = { OIDC_CLIENT_ID: 'id', OIDC_CLIENT_SECRET: 's', OIDC_DISCOVERY_URL: 'https://id.example.com/.well-known/openid-configuration' }
      expect(readAuthConfig(oidc).trustedProviders).toEqual([])
    })
  })
})
