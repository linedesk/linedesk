// Talk to the agent from the browser, no phone number needed: serves a tiny page that joins a new
// room with the microphone and dispatches the agent into it, as if +15035550142 had been called.
// Usage: pnpm --filter @callfront/agent talk, then open http://localhost:5174
import { createServer } from 'node:http'
import { AccessToken, RoomAgentDispatch, RoomConfiguration } from 'livekit-server-sdk'
import { AGENT_NAME, requireLivekitEnv, runScript } from './env.ts'

const PORT = Number(process.env.TALK_PORT ?? 5174)
const FROM = process.env.TALK_FROM_NUMBER ?? '+15035550100'
const TO = process.env.SIM_TO_NUMBER ?? '+15035550142'

async function createToken(env: ReturnType<typeof requireLivekitEnv>) {
  const room = `call-web-${crypto.randomUUID().slice(0, 8)}`
  const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: `web-${crypto.randomUUID().slice(0, 8)}`,
    ttl: '1h',
    // The same attributes LiveKit SIP sets on a phone caller.
    attributes: { 'sip.phoneNumber': FROM, 'sip.trunkPhoneNumber': TO },
  })
  token.addGrant({ roomJoin: true, room })
  token.roomConfig = new RoomConfiguration({ agents: [new RoomAgentDispatch({ agentName: AGENT_NAME })] })
  return { room, token: await token.toJwt() }
}

const page = (url: string, room: string, token: string) => `<!doctype html>
<meta charset="utf-8">
<title>Linedesk: talk to the assistant</title>
<body style="font: 16px system-ui; max-width: 32rem; margin: 4rem auto; padding: 0 1rem">
<h1 style="font-size: 1.25rem">Talk to the assistant</h1>
<p>Room <code>${room}</code>, calling <code>${TO}</code> from <code>${FROM}</code>.</p>
<button id="call" style="font: inherit; padding: .5rem 1rem">Start call</button>
<p id="status">Not connected.</p>
<script type="module">
  import { Room, RoomEvent } from 'https://cdn.jsdelivr.net/npm/livekit-client@2/+esm'
  const status = text => (document.getElementById('status').textContent = text)
  const button = document.getElementById('call')
  const room = new Room()
  room.on(RoomEvent.TrackSubscribed, track => document.body.appendChild(track.attach()))
  room.on(RoomEvent.ParticipantConnected, () => status('The assistant joined. Speak.'))
  room.on(RoomEvent.Disconnected, () => { status('Call ended. Reload for a new call.'); button.disabled = true })
  button.onclick = async () => {
    if (room.state === 'connected') return room.disconnect()
    try {
      status('Connecting…')
      await room.connect(${JSON.stringify(url)}, ${JSON.stringify(token)})
      await room.localParticipant.setMicrophoneEnabled(true)
      button.textContent = 'Hang up'
      status('Connected, waiting for the assistant…')
    } catch (e) {
      status('Could not connect: ' + e.message)
    }
  }
</script>
`

async function main() {
  const env = requireLivekitEnv()
  createServer(async (_req, res) => {
    const { room, token } = await createToken(env)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page(env.LIVEKIT_URL, room, token))
  // Loopback only: this page hands out room tokens without any sign-in.
  }).listen(PORT, '127.0.0.1', () => console.log(`Open http://localhost:${PORT} and press "Start call" (the agent worker must be running).`))
}

runScript(main)
