// Shared by the app's parts: the install's address and the request helpers. A Linedesk install is Linedesk Cloud
// (https://app.linedesk.ai) or the business's own server; the connection stores its address next to the API key.
const crypto = require('node:crypto')

const CLOUD_URL = 'https://app.linedesk.ai'

/** The install's address without a trailing slash; Linedesk Cloud when none is given. */
const baseUrl = bundle => (bundle.authData.linedesk_url || CLOUD_URL).trim().replace(/\/+$/, '')

/** POST /v1/actions/<name>: every Linedesk write is an action. A retry of the same step sends the same idempotency key. */
async function runAction(z, bundle, name, input, idempotencyKey = crypto.randomUUID()) {
  const response = await z.request({
    url: `${baseUrl(bundle)}/v1/actions/${name}`,
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: input,
  })
  return response.data
}

/** GET a Linedesk read (/v1/...). */
async function get(z, bundle, path, params) {
  const response = await z.request({ url: `${baseUrl(bundle)}${path}`, method: 'GET', params })
  return response.data
}

module.exports = { CLOUD_URL, baseUrl, get, runAction }
