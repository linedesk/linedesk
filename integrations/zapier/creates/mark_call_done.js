// Action: mark a call done in the Linedesk inbox (call.markDone), e.g. once the job is in your field-service tool.
const { runAction } = require('../lib.js')

module.exports = {
  key: 'mark_call_done',
  noun: 'Call',
  display: { label: 'Mark Call Done', description: 'Moves a call to Done in the Linedesk inbox.' },
  operation: {
    inputFields: [
      { key: 'call_id', label: 'Call ID', required: true, helpText: 'The Call ID from the Call Finished trigger.' },
    ],
    perform: async (z, bundle) => {
      const result = await runAction(z, bundle, 'call.markDone', { callId: bundle.inputData.call_id })
      const call = result.rows.calls?.[0]
      return { id: bundle.inputData.call_id, inbox_state: call?.inbox_state ?? 'done' }
    },
    sample: { id: 'call_3f2a9c1d7e4b5a6c8d90', inbox_state: 'done' },
  },
}
