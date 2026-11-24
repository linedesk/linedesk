// Hidden triggers behind the dropdowns (calls, contacts, team members, …): GET /v1/integrations/options/<kind> of
// the connected workspace, worded for a person picking one.
const { get } = require('../lib/request.js')

const day = iso => (iso ? String(iso).slice(0, 16).replace('T', ' ') : '')
const join = parts => parts.filter(Boolean).join(' · ')

const KINDS = {
  calls: { noun: 'Call', label: o => join([o.title || 'Call', o.from_number, day(o.started_at)]) },
  deleted_calls: { noun: 'Call', label: o => join([o.title || 'Call', o.from_number, day(o.started_at)]) },
  contacts: { noun: 'Contact', label: o => join([o.name || o.phone, o.company, o.name ? o.phone : null]) },
  deleted_contacts: { noun: 'Contact', label: o => join([o.name || o.phone, o.company, o.name ? o.phone : null]) },
  members: { noun: 'Team Member', label: o => join([o.name, o.role]) },
  assistants: { noun: 'Assistant', label: o => o.name || o.id },
  appointment_types: { noun: 'Appointment Type', label: o => join([o.name, o.duration_min ? `${o.duration_min} min` : null]) },
  calendars: { noun: 'Calendar', label: o => join([o.name, o.assistant_name, o.is_default ? 'default' : null]) },
  bookings: { noun: 'Booking', label: o => join([o.title || 'Booking', day(o.start_at)]) },
}

const triggers = Object.fromEntries(
  Object.entries(KINDS).map(([kind, { noun, label }]) => {
    const key = `option_${kind}`
    return [
      key,
      {
        key,
        noun,
        display: { label: `List ${kind.replace(/_/g, ' ')}`, description: `The ${kind.replace(/_/g, ' ')} to pick from.`, hidden: true },
        operation: {
          perform: async (z, bundle) =>
            (await get(z, bundle, `/v1/integrations/options/${kind}`)).options.map(o => ({ ...o, label: label(o) })),
        },
      },
    ]
  }),
)

module.exports = { triggers, KINDS }
