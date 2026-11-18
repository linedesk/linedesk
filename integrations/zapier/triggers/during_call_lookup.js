// Instant trigger: during a call the assistant asked one of its lookups (Assistant › Advanced › Webhook › during the call, e.g.
// "order status") and got an answer. Zapier cannot answer the assistant in time (a few seconds); this tells the Zap
// what was asked and answered, e.g. to log it.
const { hookTrigger, nestedCaller } = require('../lib/hook.js')

module.exports = hookTrigger({
  event: 'during_call_lookup',
  noun: 'Lookup',
  label: 'During-Call Lookup',
  description:
    "Triggers when your assistant looked something up during a call through its during-call webhook: what the caller gave, and the webhook's answer.",
  sample: {
    id: 'whd_7c1e2f',
    event: 'during_call_lookup',
    lookup: 'order_status',
    values: { order_number: '1234' },
    values_text: 'order_number: 1234',
    answered: true,
    answer: 'Order 1234 shipped on Monday and arrives Thursday.',
    asked_at: '2026-11-12T16:02:40.000Z',
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
  },
  outputFields: [
    { key: 'id', label: 'Lookup ID' },
    { key: 'lookup', label: 'Lookup' },
    { key: 'values_text', label: 'Values Given' },
    { key: 'answered', label: 'Answered', type: 'boolean' },
    { key: 'answer', label: 'Answer' },
    { key: 'asked_at', label: 'Asked At', type: 'datetime' },
    { key: 'call_id', label: 'Call ID' },
    { key: 'from_number', label: 'Caller Number' },
    { key: 'assistant_name', label: 'Assistant' },
    { key: 'caller_name', label: 'Caller Name' },
    { key: 'caller_company', label: 'Caller Company' },
    { key: 'caller_email', label: 'Caller Email' },
    { key: 'caller_contact_id', label: 'Contact ID' },
    ...nestedCaller,
    { key: 'caller_verified', label: 'Caller Number Verified', type: 'boolean' },
  ],
})
