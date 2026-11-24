// Names of the install's carrier objects, in a module without imports: outbound-policy.ts and forwarding-check.ts import
// each other (through handlers.ts the server loads forwarding-check.ts first), so a name one of them reads at module
// top level must not live in the other. src/boot-imports.test.ts loads the server's module graph in server.ts order.

/** The LiveKit outbound trunk and the carrier objects forwarding checks dial through. */
export const CHECK_TRUNK_NAME = 'linedesk-forwarding-check'
