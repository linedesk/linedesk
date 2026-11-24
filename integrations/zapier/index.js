// Linedesk on Zapier (docs/api.md, Integrations): instant triggers before, during and after a call, every public
// action of the API (generated from the registry, generated/actions.json), searches, and Run Any Action for actions
// newer than this version. All through the public API with a workspace API key.
const { version } = require('./package.json')
const { version: platformVersion } = require('zapier-platform-core')
const authentication = require('./authentication.js')
const { addApiKey, handleErrors } = require('./middleware.js')
const generated = require('./lib/generated.js')
const callFinished = require('./triggers/call_finished.js')
const callStarted = require('./triggers/call_started.js')
const duringCallLookup = require('./triggers/during_call_lookup.js')
const options = require('./triggers/options.js')
const findContact = require('./searches/find_contact.js')
const findCall = require('./searches/find_call.js')
const runAction = require('./creates/run_action.js')

module.exports = {
  version,
  platformVersion,
  authentication,
  beforeRequest: [addApiKey],
  afterResponse: [handleErrors],
  triggers: {
    [callStarted.key]: callStarted,
    [duringCallLookup.key]: duringCallLookup,
    [callFinished.key]: callFinished,
    ...options.triggers,
    [runAction.optionsTrigger.key]: runAction.optionsTrigger,
  },
  searches: { [findContact.key]: findContact, [findCall.key]: findCall, ...generated.searches },
  creates: { ...generated.creates, [runAction.create.key]: runAction.create },
  searchOrCreates: {
    [findContact.key]: {
      key: findContact.key,
      display: { label: 'Find or Create Contact', description: 'Finds a contact by phone number, or adds one.' },
      search: findContact.key,
      create: 'create_contact',
    },
  },
}
