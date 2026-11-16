// Instant trigger: a phone call came in and the assistant answered. Sent a few seconds after it rings, so the
// call-start webhook's caller details are in. Only a notice: the call does not wait for the Zap.
const { hookTrigger, nestedCaller } = require('../lib/hook.js')

module.exports = hookTrigger({
  event: 'call_started',
  noun: 'Call',
  label: 'Call Started',
  description:
    'Triggers when a phone call comes in and your assistant answers it: the caller and their number, while the call is still on.',
  sample: {
    id: 'call_3f2a9c1d7e4b5a6c8d90',
    event: 'call_started',
    call_id: 'call_3f2a9c1d7e4b5a6c8d90',
    workspace_id: 'ws_brightwater',
    assistant_id: 'as_maya',
    assistant_name: 'Maya',
    from_number: '+15035550123',
    to_number: '+15035550100',
    started_at: '2026-11-12T16:02:11.000Z',
    caller: { contact_id: 'ct_sam', name: 'Sam Taylor', name_confirmed: true, company: null, email: 'sam@example.com' },
    caller_name: 'Sam Taylor',
    caller_company: null,
    caller_email: 'sam@example.com',
    caller_contact_id: 'ct_sam',
    caller_verified: true,
    caller_details: null,
  },
  outputFields: [
    { key: 'id', label: 'Call ID' },
    { key: 'started_at', label: 'Started At', type: 'datetime' },
    { key: 'from_number', label: 'Caller Number' },
    { key: 'to_number', label: 'Number Called' },
    { key: 'assistant_name', label: 'Assistant' },
    { key: 'caller_name', label: 'Caller Name' },
    { key: 'caller_company', label: 'Caller Company' },
    { key: 'caller_email', label: 'Caller Email' },
    { key: 'caller_contact_id', label: 'Contact ID' },
    ...nestedCaller,
    { key: 'caller_verified', label: 'Caller Number Verified', type: 'boolean' },
  ],
})
