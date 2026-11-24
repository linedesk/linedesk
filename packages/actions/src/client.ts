// What the web app and the API agree on beyond the actions themselves. A page sends its protocol
// with every request that reads or writes a workspace; the API refuses a browser page older than
// CLIENT_PROTOCOL ("Linedesk was updated, reload"), so a tab opened before a deploy never writes the
// old way. Bump it when a deploy changes what such a request must carry.
// 1: the tab's workspace in `x-workspace-id` (tenancy, #204).

export const CLIENT_PROTOCOL = 1
export const CLIENT_PROTOCOL_HEADER = 'x-linedesk-client'
