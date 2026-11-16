// A workspace API key (Linedesk: Workspace settings › Developers), sent as a Bearer token. The test reads the key's
// workspace, whose name labels the connection in Zapier.
const { CLOUD_URL, get } = require('./lib.js')

module.exports = {
  type: 'custom',
  fields: [
    {
      key: 'linedesk_url',
      label: 'Linedesk address',
      type: 'string',
      required: false,
      default: CLOUD_URL,
      helpText: `Leave it as ${CLOUD_URL} for Linedesk Cloud. On your own server, its address, e.g. https://linedesk.example.com.`,
    },
    {
      key: 'api_key',
      label: 'API key',
      type: 'password',
      required: true,
      helpText:
        'In Linedesk: Workspace settings › Developers › Create key. **Member** is enough for every trigger and action here.',
    },
  ],
  test: async (z, bundle) => get(z, bundle, '/v1/api-key'),
  connectionLabel: '{{workspace.name}}',
}
