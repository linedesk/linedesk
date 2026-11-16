// Instant trigger: a phone call ended and was summarized. A REST hook (Linedesk's integration.subscribe): Zapier's
// hook URL is subscribed when the Zap is turned on and ended when it is turned off; Linedesk POSTs each finished call
// about 20 seconds after it ends. Test calls and spam send nothing. performList reads the newest calls for samples.
const { get, runAction } = require('../lib.js')
const sample = require('./call_finished.sample.json')

const performSubscribe = async (z, bundle) => {
  const result = await runAction(z, bundle, 'integration.subscribe', {
    source: 'zapier',
    event: 'call_finished',
    targetUrl: bundle.targetUrl,
  })
  return result.data
}

const performUnsubscribe = async (z, bundle) => {
  const result = await runAction(z, bundle, 'integration.unsubscribe', {
    subscriptionId: bundle.subscribeData.subscriptionId,
  })
  return result.data
}

/** What Linedesk POSTed: one call. */
const perform = async (_z, bundle) => [bundle.cleanedRequest]

const performList = async (z, bundle) => (await get(z, bundle, '/v1/integrations/calls', { limit: 3 })).calls

module.exports = {
  key: 'call_finished',
  noun: 'Call',
  display: {
    label: 'Call Finished',
    description:
      'Triggers when your assistant finished a phone call: caller, summary, next steps, bookings and the transcript.',
  },
  operation: {
    type: 'hook',
    performSubscribe,
    performUnsubscribe,
    perform,
    performList,
    sample,
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
      { key: 'outcome', label: 'Outcome' },
      { key: 'urgency', label: 'Urgency' },
      { key: 'title', label: 'Title' },
      { key: 'summary', label: 'Summary' },
      { key: 'next_steps_text', label: 'Next Steps' },
      { key: 'fields_text', label: 'Noted Details' },
      { key: 'booking_start_at', label: 'Booking Start', type: 'datetime' },
      { key: 'booking_end_at', label: 'Booking End', type: 'datetime' },
      { key: 'booking_title', label: 'Booking Title' },
      { key: 'assistant_name', label: 'Assistant' },
      { key: 'transcript_text', label: 'Transcript' },
      { key: 'call_url', label: 'Call in Linedesk' },
      { key: 'recording_url', label: 'Recording Link (7 Days)' },
    ],
  },
}
