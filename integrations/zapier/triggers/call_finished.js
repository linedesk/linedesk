// Instant trigger: a phone call ended and was summarized. Linedesk POSTs it about 20 seconds after it ends; test
// calls and spam send nothing.
const { get } = require('../lib/request.js')
const { hookTrigger, nestedCaller } = require('../lib/hook.js')
const sample = require('./call_finished.sample.json')

module.exports = hookTrigger({
  event: 'call_finished',
  noun: 'Call',
  label: 'Call Finished',
  description: 'Triggers when your assistant finished a phone call: caller, summary, next steps, bookings and the transcript.',
  sample,
  // GET /v1/integrations/calls: also on installs from before /samples.
  list: async (z, bundle) => (await get(z, bundle, '/v1/integrations/calls', { limit: 3 })).calls,
  outputFields: [
    { key: 'id', label: 'Call ID' },
    { key: 'started_at', label: 'Started At', type: 'datetime' },
    { key: 'ended_at', label: 'Ended At', type: 'datetime' },
    { key: 'duration_sec', label: 'Duration (Seconds)', type: 'integer' },
    { key: 'from_number', label: 'Caller Number' },
    { key: 'to_number', label: 'Number Called' },
    { key: 'caller_name', label: 'Caller Name' },
    { key: 'caller_company', label: 'Caller Company' },
    { key: 'caller_email', label: 'Caller Email' },
    { key: 'caller_contact_id', label: 'Contact ID' },
    ...nestedCaller,
    { key: 'outcome', label: 'Outcome' },
    { key: 'urgency', label: 'Urgency' },
    { key: 'title', label: 'Title' },
    { key: 'summary', label: 'Summary' },
    { key: 'next_steps_text', label: 'Next Steps' },
    { key: 'next_steps[]text', label: 'Next Steps › Each Step' },
    { key: 'next_steps[]kind', label: 'Next Steps › Kind' },
    { key: 'fields_text', label: 'Noted Details' },
    { key: 'fields[]label', label: 'Noted Details › Label' },
    { key: 'fields[]value', label: 'Noted Details › Value' },
    { key: 'booking_start_at', label: 'Booking Start', type: 'datetime' },
    { key: 'booking_end_at', label: 'Booking End', type: 'datetime' },
    { key: 'booking_title', label: 'Booking Title' },
    { key: 'assistant_name', label: 'Assistant' },
    { key: 'transcript_text', label: 'Transcript' },
    { key: 'transcript[]speaker', label: 'Transcript › Speaker' },
    { key: 'transcript[]text', label: 'Transcript › Text' },
    { key: 'call_url', label: 'Call in Linedesk' },
    { key: 'recording_url', label: 'Recording Link (24 Hours)' },
  ],
})
