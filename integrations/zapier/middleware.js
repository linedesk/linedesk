// Every request carries the API key; every answer that is not 2xx becomes an error with Linedesk's own words.
const addApiKey = (request, _z, bundle) => {
  if (bundle.authData.api_key) request.headers.authorization = `Bearer ${bundle.authData.api_key}`
  request.headers.accept = 'application/json'
  return request
}

const handleErrors = (response, z) => {
  if (response.status >= 200 && response.status < 300) return response
  const said =
    response.data && typeof response.data.error === 'string'
      ? response.data.error
      : `Linedesk answered ${response.status}`
  if (response.status === 401)
    throw new z.errors.Error(`The API key does not work: ${said}`, 'AuthenticationError', 401)
  if (response.status === 429) throw new z.errors.ThrottledError(said, Number(response.getHeader('retry-after')) || 60)
  throw new z.errors.Error(said, 'LinedeskError', response.status)
}

module.exports = { addApiKey, handleErrors }
