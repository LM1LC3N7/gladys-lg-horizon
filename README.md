# gladys-lg-horizon

[Gladys Assistant](https://gladysassistant.com) external integration for
**LG Horizon** set-top boxes (Ziggo, Telenet, BASE, Sunrise, Virgin Media UK
and Ireland, UPC Poland), through the operator's cloud (REST + MQTT over a
secure WebSocket): power state, channel and program shown, playing or paused,
and push buttons to wake up, put in standby, play, pause, next and previous
channel. Unofficial, not affiliated with LG, Liberty Global or the operators.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Work in progress (milestone 1).** Never tested with a real account: tested
> against a simulated cloud and broker only.

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (HorizonApp)
                                   ├─ src/horizon/session.js  POST <api>/auth-service/v1/authorization[/refresh]
                                   ├─ src/horizon/api.js      backoffice.json, customer, channels, lookups, MQTT token
                                   ├─ src/horizon/live.js     MQTT.js over wss://…/mqtt (household id + MQTT token)
                                   ├─ src/model.js            -> Gladys devices and states (pure)
                                   └─ src/store.js            /data/lg-horizon.json
```

- **Login**: user name and password (Ziggo, Virgin Media IE, UPC PL) or a
  refresh token read from the operator's web TV site (Telenet, BASE, Sunrise,
  Virgin Media UK). The refresh token changes at every use: the newest one is
  kept in `/data` (0600) against a SHA-256 digest of the configured
  credentials, never the password. Session cookies (ACCESSTOKEN) are kept from
  the auth answer and sent back to the operator's hosts only.
- **Refusals** (97401 credentials, 97402 token, or the service's own JSON
  refusal): a stop kept in `/data`, never retried by itself; new credentials or
  the "Reconnect" button try once. A 403 without the service's JSON
  (CloudFront, proxy), a 5xx or a network error is a passing error: tried again
  after 1, 2, 5, 15, 30 minutes.
- **429**: a pause of 1 min to 6 h (Retry-After, else 15 min), kept in `/data`
  and read back bounded, applied to every REST call (live link and lookups
  included).
- **Session renewal**: by a timer, one day before the refresh token expires,
  between 10 min and 12 h from now; a failed renewal is tried again after 5,
  15, 60 minutes. A 401 of an API call renews once (at most once a minute) and
  retries once.
- **Live link**: one MQTT connection (protocol 3.1.1, `reconnectPeriod: 0`),
  the household's topics only (`<hh>/+/status` required; `<hh>`,
  `<hh>/<client id>`, `<hh>/#` optional). Reconnection after 30 s, 1, 2, 5, 10,
  15 min; the count only resets after a connection stayed up 2 minutes, so a
  socket that opens then drops never loops. Each connection asks a fresh MQTT
  token.
- **States**: running state from `<hh>/<box>/status`, UI from `CPE.uiStatus`
  (asked with `CPE.getUiStatus` at connection, after a command, at the end of
  the program, every 15 min). The program title comes from the replay event,
  VOD or recording lookup; a failed lookup never blocks the channel.
- **Commands**: `CPE.KeyEvent` keys `Power`, `MediaPlayPause`, `ChannelUp`,
  `ChannelDown` (QoS 2), serialized per box, within 3.8 s of the request of
  Gladys. The toggles are sent only when the live state (followed since the
  link came up) is the opposite of the request; a guard ignores any other one
  until the expected state (45 s / 10 s at most). The ack only waits for the
  broker, never for Gladys.
- **Discovery and status** are published again at every `connected`; a
  device published again keeps the features of the created one.

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit
npx github:GladysAssistant/integration-store .  # store admission checks
node scripts/cover.mjs cover.png                # regenerate the cover
```

`test/helpers/` holds a fake operator cloud behind `fetch`, a fake MQTT broker
and a clock moved by hand.

## Credits

- [Sholofly/lghorizon-python](https://github.com/Sholofly/lghorizon-python)
  (MIT), 0.12.2, the library of the Home Assistant integration: read as the
  reference and ported to JavaScript (no Python runs here).
- [MQTT.js](https://github.com/mqttjs/MQTT.js) (MIT), the MQTT client, a runtime
  dependency.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release. The
`gladys-assistant-integration` topic lists the repository in the Gladys store
(added at the first real release).

## License

Apache-2.0 (see [LICENSE](LICENSE)); the logic ported from lghorizon (MIT) is
listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). LG Horizon is a
trademark of its owners; this project is not affiliated with LG, Liberty Global
or the operators.
