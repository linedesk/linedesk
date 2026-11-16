// Search: the Linedesk contact with a phone number (GET /v1/integrations/contacts).
const { get } = require('../lib/request.js')

const sample = {
  id: 'ct_sam',
  name: 'Sam Taylor',
  company: null,
  phone: '+15035550123',
  email: 'sam@example.com',
  address: null,
  note: null,
  blocked_at: null,
  created_at: '2026-11-12T16:03:46.000Z',
}

module.exports = {
  key: 'find_contact',
  noun: 'Contact',
  display: { label: 'Find Contact', description: 'Finds a Linedesk contact by phone number.' },
  operation: {
    inputFields: [
      {
        key: 'phone',
        label: 'Phone Number',
        required: true,
        helpText: 'Best in international format (+15035550123); a national number is read as one of the country below.',
      },
      { key: 'country', label: 'Country', required: false, default: 'US', helpText: 'Two letters, e.g. US, CA, GB.' },
    ],
    perform: async (z, bundle) =>
      (
        await get(z, bundle, '/v1/integrations/contacts', {
          phone: bundle.inputData.phone,
          country: bundle.inputData.country || 'US',
        })
      ).contacts,
    sample,
  },
}
