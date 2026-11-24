// The app against a mocked Linedesk (nock): what it sends, where, with which key, and what it hands Zapier.
const assert = require('node:assert/strict')
const { afterEach, before, describe, test } = require('node:test')
const nock = require('nock')
const zapier = require('zapier-platform-core')
// What `zapier validate` checks: the compiled definition against Zapier's schema.
const { compileApp, validateApp } = require('zapier-platform-core/src/tools/schema')
const App = require('../index.js')

const appTester = zapier.createAppTester(App)
const BASE = 'https://linedesk.example.com'
const KEY = 'ld_test_key'
const authData = { linedesk_url: `${BASE}/`, api_key: KEY }
const auth = { reqheaders: { authorization: `Bearer ${KEY}` } }

before(() => nock.disableNetConnect())
afterEach(() => {
  assert.ok(nock.isDone(), `requests not made: ${nock.pendingMocks()}`)
  nock.cleanAll()
})

test('the app definition is valid for Zapier', () => {
  assert.deepEqual(validateApp(compileApp(App)), [])
})

describe('authentication', () => {
  test("the test reads the key's workspace; the label is its name", async () => {
    nock(BASE, auth)
      .get('/v1/api-key')
      .reply(200, {
        ok: true,
        workspace: { id: 'ws_1', name: 'Brightwater Plumbing & Heating' },
        key: { role: 'member' },
      })
    const result = await appTester(App.authentication.test, { authData })
    assert.equal(result.workspace.name, 'Brightwater Plumbing & Heating')
    assert.equal(App.authentication.connectionLabel, '{{workspace.name}}')
  })

  test('Linedesk Cloud when no address is given', async () => {
    nock('https://app.linedesk.ai', auth)
      .get('/v1/api-key')
      .reply(200, { ok: true, workspace: { name: 'Cloud' } })
    const result = await appTester(App.authentication.test, { authData: { api_key: KEY } })
    assert.equal(result.workspace.name, 'Cloud')
  })

  test("a key Linedesk refuses fails with Linedesk's words", async () => {
    nock(BASE).get('/v1/api-key').reply(401, { ok: false, error: 'unknown or revoked API key' })
    await assert.rejects(appTester(App.authentication.test, { authData }), /unknown or revoked API key/)
  })
})

describe('Call Finished', () => {
  const trigger = App.triggers.call_finished.operation

  test('subscribing sends the hook URL and keeps the subscription id; unsubscribing ends it', async () => {
    nock(BASE, auth)
      .post('/v1/actions/integration.subscribe', {
        source: 'zapier',
        event: 'call_finished',
        targetUrl: 'https://hooks.zapier.com/hooks/standard/1/abc',
      })
      .matchHeader('idempotency-key', /.+/)
      .reply(200, { ok: true, rows: {}, data: { subscriptionId: 'isub_1' } })
    const subscribeData = await appTester(trigger.performSubscribe, {
      authData,
      targetUrl: 'https://hooks.zapier.com/hooks/standard/1/abc',
    })
    assert.deepEqual(subscribeData, { subscriptionId: 'isub_1' })

    nock(BASE, auth)
      .post('/v1/actions/integration.unsubscribe', { subscriptionId: 'isub_1' })
      .reply(200, { ok: true, rows: {}, data: { subscriptionId: 'isub_1', removed: true } })
    const ended = await appTester(trigger.performUnsubscribe, { authData, subscribeData })
    assert.equal(ended.removed, true)
  })

  test('a delivered call is the one item; the samples are the newest calls', async () => {
    const call = { id: 'call_1', summary: 'Water heater leaking.' }
    assert.deepEqual(await appTester(trigger.perform, { authData, cleanedRequest: call }), [call])

    nock(BASE, auth)
      .get('/v1/integrations/calls')
      .query({ limit: 3 })
      .reply(200, { ok: true, calls: [call] })
    assert.deepEqual(await appTester(trigger.performList, { authData }), [call])
  })

})

/** A value of the sample at an output key: `caller__name` is caller.name, `next_steps[]text` each step's text. */
function at(sample, key) {
  const [list, item] = key.split('[]')
  if (item) return Array.isArray(sample[list]) && sample[list].length > 0 ? sample[list][0][item] : undefined
  return key.split('__').reduce((value, part) => (value && typeof value === 'object' && part in value ? value[part] : undefined), sample)
}

describe('every trigger', () => {
  for (const key of ['call_started', 'during_call_lookup', 'call_finished']) {
    const trigger = App.triggers[key].operation

    test(`${key}: the sample has every output field, no two share a label`, () => {
      for (const field of trigger.outputFields) {
        const sampleHasIt = field.key.includes('[]') ? field.key.split('[]')[0] in trigger.sample : at(trigger.sample, field.key) !== undefined || field.key.split('__')[0] in trigger.sample
        assert.ok(sampleHasIt, field.key)
      }
      const labels = trigger.outputFields.map(f => f.label)
      assert.equal(new Set(labels).size, labels.length)
    })

    test(`${key}: subscribes its own event; delivered as sent, without Zapier's querystring`, async () => {
      nock(BASE, auth)
        .post('/v1/actions/integration.subscribe', { source: 'zapier', event: key, targetUrl: 'https://hooks.zapier.com/x' })
        .reply(200, { ok: true, rows: {}, data: { subscriptionId: 'isub_2' } })
      assert.deepEqual(await appTester(trigger.performSubscribe, { authData, targetUrl: 'https://hooks.zapier.com/x' }), {
        subscriptionId: 'isub_2',
      })
      const event = { id: 'x_1', event: key }
      assert.deepEqual(await appTester(trigger.perform, { authData, cleanedRequest: { ...event, querystring: {} } }), [event])
    })
  }

  test('the samples of call_started and during_call_lookup come from /samples', async () => {
    for (const key of ['call_started', 'during_call_lookup']) {
      nock(BASE, auth)
        .get(`/v1/integrations/samples/${key}`)
        .query({ limit: 3 })
        .reply(200, { ok: true, items: [{ id: 'x_1', event: key }] })
      assert.deepEqual(await appTester(App.triggers[key].operation.performList, { authData }), [{ id: 'x_1', event: key }])
    }
  })
})

describe('contacts and calls', () => {
  test('Find Contact asks by number and country', async () => {
    const contact = { id: 'ct_1', phone: '+15035550123', name: 'Sam Taylor' }
    nock(BASE, auth)
      .get('/v1/integrations/contacts')
      .query({ phone: '+15035550123', country: 'US' })
      .reply(200, { ok: true, contacts: [contact] })
    const found = await appTester(App.searches.find_contact.operation.perform, {
      authData,
      inputData: { phone: '+15035550123' },
    })
    assert.deepEqual(found, [contact])
  })

  test('Create Contact sends the number in E.164 and only the fields given', async () => {
    const contact = { id: 'ct_2', phone: '+15035550188', name: 'Pat Lee' }
    nock(BASE, auth)
      .post('/v1/actions/contact.create', { phone: '+15035550188', name: 'Pat Lee' })
      .reply(200, { ok: true, rows: { contacts: [contact] }, data: { contactId: 'ct_2' } })
    const created = await appTester(App.creates.create_contact.operation.perform, {
      authData,
      inputData: { phone: '+1 (503) 555-0188', name: ' Pat Lee ', company: '  ' },
    })
    assert.deepEqual(created, { action: 'contact.create', ...contact, contactId: 'ct_2' })
  })

  test("Mark Call Done runs call.markDone; Linedesk's refusal comes back as the error", async () => {
    nock(BASE, auth)
      .post('/v1/actions/call.markDone', { callId: 'call_1' })
      .reply(200, { ok: true, rows: { calls: [{ id: 'call_1', inbox_state: 'done' }] } })
    const done = await appTester(App.creates.mark_call_done.operation.perform, {
      authData,
      inputData: { call_id: 'call_1' },
    })
    assert.deepEqual(done, { action: 'call.markDone', id: 'call_1', inbox_state: 'done' })

    nock(BASE).post('/v1/actions/call.markDone').reply(409, { ok: false, error: 'call not found' })
    await assert.rejects(
      appTester(App.creates.mark_call_done.operation.perform, { authData, inputData: { call_id: 'call_x' } }),
      /call not found/,
    )
  })
})

describe('the API, generated from the registry', () => {
  const generated = require('../generated/actions.json')

  test('every public action is a step, but never subscribe or unsubscribe', () => {
    const steps = { ...App.creates, ...App.searches }
    const names = new Set(Object.values(steps).map(s => s.key))
    assert.ok(generated.length >= 20)
    for (const action of generated) assert.ok(names.has(action.key) || ['contact.create', 'call.markDone'].includes(action.name), action.name)
    assert.ok(!generated.some(a => a.name.startsWith('integration.')))
  })

  test('every search has an input field: Zapier refuses a push without one (D009)', () => {
    for (const search of Object.values(App.searches)) assert.ok(search.operation.inputFields.length > 0, search.key)
  })

  test('fields: dropdowns, dates cut to a day, booleans, line items, blank left out, null to unassign', async () => {
    nock(BASE, auth)
      .post('/v1/actions/call.assign', { callId: 'call_1', userId: null, notify: false })
      .reply(200, { ok: true, rows: { calls: [{ id: 'call_1', assigned_to: null }] } })
    const assign = App.creates.call_assign.operation
    assert.equal(assign.inputFields.find(f => f.key === 'userId').dynamic, 'option_members.id.label')
    await appTester(assign.perform, { authData, inputData: { callId: 'call_1', userId: '', notify: 'no' } })

    nock(BASE, auth)
      .post('/v1/actions/call.setActionItems', { callId: 'call_1', items: [{ text: 'Call back', done: true }] })
      .reply(200, { ok: true, rows: { calls: [{ id: 'call_1' }] } })
    await appTester(App.creates.call_set_action_items.operation.perform, {
      authData,
      inputData: { callId: 'call_1', items: [{ text: 'Call back', done: 'true' }, { text: '' }] },
    })

    nock(BASE, auth)
      .post('/v1/actions/call.export', { from: '2026-11-01', to: '2026-11-30' })
      .reply(200, { ok: true, rows: {}, data: { csv: 'a,b' } })
    const exported = await appTester(App.creates.call_export.operation.perform, {
      authData,
      inputData: { from: '2026-11-01T00:00:00-08:00', to: '2026-11-30T00:00:00-08:00', format: '' },
    })
    assert.equal(exported.csv, 'a,b')
  })

  test('Cancel Appointment picks a booking; the voice agent\'s fields are not offered', () => {
    const keys = App.creates.appointment_cancel.operation.inputFields.map(f => f.key)
    assert.deepEqual(keys, ['bookingId'])
  })

  test('searches hand Zapier a list with ids', async () => {
    nock(BASE, auth)
      .post('/v1/actions/member.list', {})
      .reply(200, { ok: true, rows: {}, data: { members: [{ userId: 'u_1', name: 'Mike Brennan', role: 'owner' }] } })
    assert.deepEqual(await appTester(App.searches.member_list.operation.perform, { authData, inputData: {} }), [
      { id: 'u_1', userId: 'u_1', name: 'Mike Brennan', role: 'owner' },
    ])
    nock(BASE, auth)
      .post('/v1/actions/member.list', {})
      .reply(200, { ok: true, rows: {}, data: { members: [{ userId: 'u_1', name: 'Mike Brennan' }, { userId: 'u_2', name: 'Ana Ruiz' }] } })
    const found = await appTester(App.searches.member_list.operation.perform, { authData, inputData: { contains: ' ana ' } })
    assert.deepEqual(found.map(m => m.id), ['u_2'])
    nock(BASE, auth)
      .post('/v1/actions/calendar.findSlots', { appointmentTypeId: 'at_1', limit: 5 })
      .reply(200, { ok: true, rows: {}, data: { slots: [{ start: 's', end: 'e', label: 'l' }] } })
    const slots = await appTester(App.searches.calendar_find_slots.operation.perform, {
      authData,
      inputData: { appointmentTypeId: 'at_1', limit: '5' },
    })
    assert.deepEqual(slots, [{ id: 's', start: 's', end: 'e', label: 'l' }])
  })

  test('Find Call reads one call by id', async () => {
    nock(BASE, auth)
      .get('/v1/integrations/calls')
      .query({ id: 'call_1' })
      .reply(200, { ok: true, calls: [{ id: 'call_1' }] })
    assert.deepEqual(await appTester(App.searches.find_call.operation.perform, { authData, inputData: { call_id: 'call_1' } }), [
      { id: 'call_1' },
    ])
  })

  test('dropdowns read /options and name each choice', async () => {
    nock(BASE, auth)
      .get('/v1/integrations/options/contacts')
      .reply(200, { ok: true, options: [{ id: 'ct_1', name: 'Sam Taylor', company: null, phone: '+15035550123' }] })
    const [choice] = await appTester(App.triggers.option_contacts.operation.perform, { authData })
    assert.equal(choice.label, 'Sam Taylor · +15035550123')
  })

  test('Run Any Action lists the install\'s actions and builds the fields from its OpenAPI', async () => {
    const openapi = {
      paths: {
        '/v1/actions/call.markDone': {
          post: {
            operationId: 'call.markDone',
            summary: 'Mark a call as done.',
            requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { callId: { type: 'string' } }, required: ['callId'] } } } },
          },
        },
        '/v1/actions/integration.subscribe': { post: { operationId: 'integration.subscribe', requestBody: {} } },
      },
    }
    nock(BASE, auth).get('/v1/openapi.json').reply(200, openapi)
    const listed = await appTester(App.triggers.option_actions.operation.perform, { authData })
    assert.deepEqual(listed.map(a => a.id), ['call.markDone'])

    nock(BASE, auth).get('/v1/openapi.json').reply(200, openapi)
    nock(BASE, auth)
      .post('/v1/actions/call.markDone', { callId: 'call_1' })
      .reply(200, { ok: true, rows: { calls: [{ id: 'call_1', inbox_state: 'done' }] } })
    const done = await appTester(App.creates.run_action.operation.perform, {
      authData,
      inputData: { action: 'call.markDone', callId: 'call_1' },
    })
    assert.equal(done.inbox_state, 'done')
  })
})
