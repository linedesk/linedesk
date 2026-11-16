// Every public Linedesk action as a Zapier action or search, from generated/actions.json (written from the
// registry: `pnpm zapier:generate`). A new public action reaches Zapier with the next release, without code here.
const actions = require('../generated/actions.json')
const { inputField, valuesOf } = require('./fields.js')
const { runAction } = require('./request.js')

/** Keys of steps that existed before the generated ones: Zaps made with them keep working. */
const KEYS = { 'contact.create': 'create_contact', 'call.markDone': 'mark_call_done' }

const SAMPLES = {
  Call: { id: 'call_3f2a9c1d7e4b5a6c8d90', title: 'Water heater leaking', from_number: '+15035550123', inbox_state: 'done', urgency: 'normal' },
  Contact: { id: 'ct_sam', name: 'Sam Taylor', company: null, phone: '+15035550123', email: 'sam@example.com', blocked_at: null },
  Booking: { id: 'bk_1', title: 'Water heater repair', start_at: '2026-11-13T17:00:00.000Z', end_at: '2026-11-13T18:00:00.000Z', status: 'confirmed' },
  Slot: { id: '2026-11-13T17:00:00.000Z', start: '2026-11-13T17:00:00.000Z', end: '2026-11-13T18:00:00.000Z', label: 'Fri, Nov 13, 9:00 AM' },
  'Team Member': { id: 'usr_mike', userId: 'usr_mike', name: 'Mike Brennan', role: 'owner' },
  Export: { csv: 'Started,From,Outcome,Summary\n2026-11-12 08:02,+15035550123,message,Water heater leaking.' },
}

/** What a create hands Zapier: the first row it wrote (the call, the contact, …) with what it returned besides. */
function createResult(action, result) {
  const tables = Object.values(result.rows ?? {}).filter(rows => Array.isArray(rows) && rows.length > 0)
  const row = tables[0]?.[0] ?? {}
  const data = result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? result.data : {}
  return { action: action.name, ...row, ...data }
}

/** What a search hands Zapier: the list in `data`, each with an id. */
function searchResult(action, result) {
  const list = action.list ? result.data?.[action.list] : result.data
  const items = Array.isArray(list) ? list : list ? [list] : []
  return items.map(item => ({ id: item.id ?? item.userId ?? item.start, ...item }))
}

function operationOf(action) {
  const search = action.kind === 'search'
  return {
    key: KEYS[action.name] ?? action.key,
    noun: action.noun,
    display: {
      label: action.label,
      description: action.description.length > 1000 ? `${action.description.slice(0, 997)}…` : action.description,
    },
    operation: {
      inputFields: action.fields.map(inputField),
      perform: async (z, bundle) => {
        const result = await runAction(z, bundle, action.name, valuesOf(action.fields, bundle.inputData))
        return search ? searchResult(action, result) : createResult(action, result)
      },
      sample: SAMPLES[action.noun] ?? { action: action.name },
    },
  }
}

const byKey = list => Object.fromEntries(list.map(op => [op.key, op]))
const creates = byKey(actions.filter(a => a.kind !== 'search').map(operationOf))
const searches = byKey(actions.filter(a => a.kind === 'search').map(operationOf))

module.exports = { creates, searches, createResult, searchResult }
