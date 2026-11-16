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

  test('the sample has the fields the outputs name', () => {
    for (const { key } of trigger.outputFields) assert.ok(key in trigger.sample, key)
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
    assert.deepEqual(created, contact)
  })

  test("Mark Call Done runs call.markDone; Linedesk's refusal comes back as the error", async () => {
    nock(BASE, auth)
      .post('/v1/actions/call.markDone', { callId: 'call_1' })
      .reply(200, { ok: true, rows: { calls: [{ id: 'call_1', inbox_state: 'done' }] } })
    const done = await appTester(App.creates.mark_call_done.operation.perform, {
      authData,
      inputData: { call_id: 'call_1' },
    })
    assert.deepEqual(done, { id: 'call_1', inbox_state: 'done' })

    nock(BASE).post('/v1/actions/call.markDone').reply(409, { ok: false, error: 'call not found' })
    await assert.rejects(
      appTester(App.creates.mark_call_done.operation.perform, { authData, inputData: { call_id: 'call_x' } }),
      /call not found/,
    )
  })
})
