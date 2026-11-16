// An instant trigger on one Linedesk event: a REST hook (integration.subscribe). Zapier's hook URL is subscribed
// when the Zap is turned on and ended when it is turned off; Linedesk POSTs each event to it. performList reads the
// newest events of the kind for samples.
const { get, runAction } = require('./request.js')

/** The event Linedesk POSTed, as it was sent (Zapier adds an empty `querystring`; it is not Linedesk's). */
const perform = async (_z, bundle) => {
  const { querystring: _querystring, ...event } = bundle.cleanedRequest ?? {}
  return [event]
}

function hookTrigger({ event, noun, label, description, sample, outputFields, list }) {
  return {
    key: event,
    noun,
    display: { label, description },
    operation: {
      type: 'hook',
      performSubscribe: async (z, bundle) =>
        (await runAction(z, bundle, 'integration.subscribe', { source: 'zapier', event, targetUrl: bundle.targetUrl })).data,
      performUnsubscribe: async (z, bundle) =>
        (await runAction(z, bundle, 'integration.unsubscribe', { subscriptionId: bundle.subscribeData.subscriptionId })).data,
      perform,
      performList: list ?? (async (z, bundle) => (await get(z, bundle, `/v1/integrations/samples/${event}`, { limit: 3 })).items),
      sample,
      outputFields,
    },
  }
}

/** The caller as nested fields: named apart from the flat ones (caller_name, …) so no two fields share a label. */
const nestedCaller = [
  { key: 'caller__contact_id', label: 'Caller › Contact ID' },
  { key: 'caller__name', label: 'Caller › Name' },
  { key: 'caller__name_confirmed', label: 'Caller › Name Confirmed', type: 'boolean' },
  { key: 'caller__company', label: 'Caller › Company' },
  { key: 'caller__email', label: 'Caller › Email' },
]

module.exports = { hookTrigger, nestedCaller, perform }
