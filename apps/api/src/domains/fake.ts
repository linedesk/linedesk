// Partner addresses without Cloudflare (development and tests, PARTNER_DOMAINS=fake): nothing leaves the process. A
// new name is pending at its creation and active at the next look, so an address moves one step per check: records
// found, certificate, live. The first label picks another path:
//   pending.…  our TXT is never found          nocname.…  Cloudflare never sees the CNAME (stays verifying)
//   failing.…  the certificate fails            held.…     Cloudflare asks for its own ownership TXT too
//   noprobe.…  everything active, but the probe through the address fails
import type { CustomHostname, DomainProvider } from './provider.ts'

const firstLabel = (hostname: string) => hostname.split('.')[0]

function fakeHostname(hostname: string, fresh: boolean): CustomHostname {
  const id = `fake_${hostname}`
  const label = firstLabel(hostname)
  const ownership = label === 'held' ? { name: `_cf-custom-hostname.${hostname}`, value: 'fake-ownership-token' } : null
  if (fresh || label === 'nocname' || label === 'held')
    return { id, hostname, status: 'pending', sslStatus: 'pending_validation', ownership, errors: [] }
  if (label === 'failing')
    return { id, hostname, status: 'pending', sslStatus: 'validation_timed_out', ownership, errors: ['timed out'] }
  return { id, hostname, status: 'active', sslStatus: 'active', ownership: null, errors: [] }
}

export function fakeDomains(cnameTarget: string): DomainProvider {
  return {
    name: 'fake',
    cnameTarget,
    create: async hostname => fakeHostname(hostname, true),
    get: async id => (id.startsWith('fake_') ? fakeHostname(id.slice('fake_'.length), false) : null),
    remove: async () => {},
    simulated: {
      txtFound: hostname => firstLabel(hostname) !== 'pending',
      probePasses: hostname => firstLabel(hostname) !== 'noprobe',
    },
  }
}
