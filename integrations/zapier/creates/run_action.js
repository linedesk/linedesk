// Action: any action of the connected Linedesk install, by name, with its fields read from the install's own
// /v1/openapi.json. Actions newer than this app version show up here at once.
const { fieldsFromSchema, inputField, valuesOf } = require('../lib/fields.js')
const { createResult } = require('../lib/generated.js')
const { get, runAction } = require('../lib/request.js')

/** The install's public actions: name, summary, input schema. */
async function publicActions(z, bundle) {
  const doc = await get(z, bundle, '/v1/openapi.json')
  return Object.values(doc.paths ?? {})
    .map(path => path.post)
    .filter(op => op?.operationId && op.requestBody && !String(op.operationId).startsWith('integration.'))
    .map(op => ({
      name: op.operationId,
      summary: op.summary ?? '',
      schema: op.requestBody.content?.['application/json']?.schema ?? {},
    }))
}

const fieldsFor = async (z, bundle) => {
  const name = bundle.inputData.action
  if (!name) return []
  const action = (await publicActions(z, bundle)).find(a => a.name === name)
  return action ? fieldsFromSchema(action.schema) : []
}

const optionsTrigger = {
  key: 'option_actions',
  noun: 'Action',
  display: { label: 'List actions', description: 'The actions of the Linedesk install.', hidden: true },
  operation: {
    perform: async (z, bundle) =>
      (await publicActions(z, bundle)).map(a => ({ id: a.name, label: `${a.name}: ${a.summary}`.slice(0, 200) })),
  },
}

const create = {
  key: 'run_action',
  noun: 'Action',
  display: {
    label: 'Run Any Action',
    description: 'Runs any action of the Linedesk API by name, also ones newer than this Zapier app.',
  },
  operation: {
    inputFields: [
      {
        key: 'action',
        label: 'Action',
        required: true,
        dynamic: 'option_actions.id.label',
        altersDynamicFields: true,
        helpText: 'The Linedesk action, e.g. call.markDone. The list comes from your Linedesk install.',
      },
      async (z, bundle) => (await fieldsFor(z, bundle)).map(inputField),
    ],
    perform: async (z, bundle) => {
      const fields = await fieldsFor(z, bundle)
      const result = await runAction(z, bundle, bundle.inputData.action, valuesOf(fields, bundle.inputData))
      return createResult({ name: bundle.inputData.action }, result)
    },
    sample: { action: 'call.markDone', id: 'call_3f2a9c1d7e4b5a6c8d90', inbox_state: 'done' },
  },
}

module.exports = { create, optionsTrigger, publicActions }
