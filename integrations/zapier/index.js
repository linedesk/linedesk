// Linedesk on Zapier (docs/api.md, Integrations): the instant "Call Finished" trigger and actions on contacts and
// calls, all through the public API with a workspace API key.
const { version } = require('./package.json')
const { version: platformVersion } = require('zapier-platform-core')
const authentication = require('./authentication.js')
const { addApiKey, handleErrors } = require('./middleware.js')
const callFinished = require('./triggers/call_finished.js')
const findContact = require('./searches/find_contact.js')
const createContact = require('./creates/create_contact.js')
const markCallDone = require('./creates/mark_call_done.js')

module.exports = {
  version,
  platformVersion,
  authentication,
  beforeRequest: [addApiKey],
  afterResponse: [handleErrors],
  triggers: { [callFinished.key]: callFinished },
  searches: { [findContact.key]: findContact },
  creates: { [createContact.key]: createContact, [markCallDone.key]: markCallDone },
  searchOrCreates: {
    [findContact.key]: {
      key: findContact.key,
      display: { label: 'Find or Create Contact', description: 'Finds a contact by phone number, or adds one.' },
      search: findContact.key,
      create: createContact.key,
    },
  },
}
