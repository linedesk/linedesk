// Action: add a contact (contact.create). A number that belonged to a deleted contact brings that contact back.
const { runAction } = require('../lib.js')
const { sample } = require('../searches/find_contact.js').operation

const FIELDS = ['name', 'company', 'email', 'address', 'note']

module.exports = {
  key: 'create_contact',
  noun: 'Contact',
  display: { label: 'Create Contact', description: 'Adds a contact to Linedesk, so the assistant knows the caller.' },
  operation: {
    inputFields: [
      { key: 'phone', label: 'Phone Number', required: true, helpText: 'In international format, e.g. +15035550123.' },
      { key: 'name', label: 'Name', required: false },
      { key: 'company', label: 'Company', required: false },
      { key: 'email', label: 'Email', required: false },
      { key: 'address', label: 'Address', required: false },
      { key: 'note', label: 'Note', required: false, type: 'text' },
    ],
    perform: async (z, bundle) => {
      const input = { phone: String(bundle.inputData.phone).replace(/[^\d+]/g, '') }
      for (const field of FIELDS) {
        const value = bundle.inputData[field]
        if (typeof value === 'string' && value.trim()) input[field] = value.trim()
      }
      const result = await runAction(z, bundle, 'contact.create', input)
      return result.rows.contacts[0]
    },
    sample,
  },
}
