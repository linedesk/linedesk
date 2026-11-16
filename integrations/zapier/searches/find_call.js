// Search: one call by its id (GET /v1/integrations/calls?id=), in the Call Finished trigger's shape.
const { get } = require('../lib/request.js')
const sample = require('../triggers/call_finished.sample.json')

module.exports = {
  key: 'find_call',
  noun: 'Call',
  display: { label: 'Find Call', description: 'Finds a Linedesk call by its id: caller, summary, next steps and transcript.' },
  operation: {
    inputFields: [{ key: 'call_id', label: 'Call', required: true, dynamic: 'option_calls.id.label', helpText: 'The Call ID, e.g. from another step.' }],
    perform: async (z, bundle) => (await get(z, bundle, '/v1/integrations/calls', { id: bundle.inputData.call_id })).calls,
    sample,
  },
}
