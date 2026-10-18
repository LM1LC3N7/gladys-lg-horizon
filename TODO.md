# TODO — LG Horizon v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only.

## Status

- [x] **Milestone 1 — cloud, live link, buttons** (2026-10-18): operators of
      lghorizon 0.12.2, login (password or refresh token), refusals and 429
      pauses kept in `/data`, session renewed by a timer, MQTT over WSS with
      spaced reconnections, per box power / reachable / channel / program /
      playing and the wake, standby, play, pause, channel up and down
      buttons; docs en/fr. Tested against a fake cloud, a fake broker and a
      fake clock only, never with a real account.
- [ ] **Milestone 2 — real accounts** (testers with a Ziggo, Telenet, Sunrise
      or Virgin Media account): record real answers as fixtures, fix what
      differs. To check first:
  - how the REST calls are authenticated: the code sends back the cookies of
    the auth answer (as aiohttp does for lghorizon 0.12) and, when none is
    named ACCESSTOKEN, adds `ACCESSTOKEN=<access token>` for the operator's
    own hosts (what lghorizon did before 0.9). Check which one the cloud
    reads, and whether the service URLs of `backoffice.json` share the
    cookie domain;
  - the MQTT WebSocket: MQTT.js offers the `mqtt` subprotocol only (Paho
    sends `mqtt, mqttv3.1, mqttv3.11`); check that the broker accepts it, and
    that the household topics are enough (lghorizon also subscribes to `#`);
  - on which topic the answer to `CPE.getUiStatus` arrives (`<hh>/<client
id>` is assumed, `<hh>/#` catches the others);
  - whether the boxes honour the idempotent keys `WakeUp` and `Standby`
    (listed in lghorizon's keys, not used by its device methods): they would
    replace the `Power` toggle and its guard;
  - the access token lifetime: the renewal follows `refreshTokenExpiry` (one
    day before, every 12 h at most) and a 401 renews once; check that no 401
    storm happens between two renewals;
  - the Telenet issue of September 2026 (login stuck with a refresh token)
    and the Sunrise and Virgin Media logins;
  - the replay event times (seconds since lghorizon 0.11; milliseconds are
    read too).
- [ ] **Milestone 3 — more**: a channel dropdown (`text/select` with the
      profile channels, `CPE.pushToTV`), record, stop, rewind/forward,
      channel number in the channel text, profile choice, the recording
      quota.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, then the store validator once the image is published.

## Decisions

- Forum: no dedicated topic, no post from this module's work; one recap per
  wave in /t/10385, posted by the main session.
- Reuse: lghorizon 0.12.2 (MIT, Sholofly/lghorizon-python) is Python, so its
  operators, requests, error codes, MQTT topics, message types and key names
  are ported to JavaScript (`src/constants.js`, `src/horizon/`); MIT notice in
  `THIRD_PARTY_NOTICES.md`, copied into the image. Neighbour module:
  LM1LC3N7/gladys-denon-avr (multimedia), and the structure of
  gladys-devialet / gladys-yolink.
- Operators: those of lghorizon 0.12.2 (`COUNTRY_SETTINGS`) without its
  preproduction entry: Ziggo, Telenet, BASE, Sunrise, Virgin Media UK and IE,
  UPC PL. Magenta TV (Austria) was asked for but is not served: it never was
  in lghorizon (no API address known), no issue mentions it; said in the
  docs. Recent issues (2026): Ziggo and Telenet active; Sunrise and Virgin
  logins refused early 2026 then fixed; an open Telenet issue (09/2026) of a
  login stuck with a refresh token. Said in the docs.
- MQTT client: **MQTT.js** (`mqtt`, MIT), a runtime dependency. Reasons: the
  broker is MQTT 3.1.1 over a secure WebSocket (`wss://…/mqtt`) with QoS 2
  publishes; writing a client would mean a WebSocket client (TLS, framing,
  masking) plus MQTT packets, QoS 2 flows and keepalive, a lot of untested
  code for one module. MQTT.js is the reference Node client (weekly releases,
  millions of downloads, used by gladys-yolink already). It brings about 40
  transitive runtime packages (45 in the production tree with the SDK and
  `ws`), all under permissive licences (MIT 39, ISC 3, Apache-2.0,
  BSD-3-Clause, 0BSD), and `npm audit --omit=dev` is clean. Its frames are
  capped (`wsOptions.maxPayload` 256 KB). Its own
  reconnection is off (`reconnectPeriod: 0`): every connection needs a fresh
  MQTT token, and the delays are ours.
- Standby: **two push buttons** (`button/push` "Wake up" and "Standby"), not a
  switch. The power state is read only (`unknown/binary`): nothing an
  "everything off" (voice assistants, MCP, scenes `switch.*`) could take as a
  command. Play, pause and the channel keys are `television` push types.
- No volume: the cloud API has no volume key (lghorizon has none; the volume
  belongs to the TV).
- Toggles (power, play/pause): the key is sent only when the state the box
  reported over the live link, followed without a break since the link came
  up, is the opposite of the request (a running box and "Wake up": nothing
  sent, success). Unknown state (offline, link down, nothing reported yet):
  refused, nothing sent. A guard is set as soon as the key may have left
  (before the broker acknowledges), and ends only on the expected state (not
  on the state of departure, not on an unknown one) or after 45 s (power) /
  10 s (play). While it holds, any power (play) command is ignored with an
  error, even a "nothing to do".
- Command values are not read: Gladys sends a press (the buttons have no
  target value).
- Commands: serialized per box, 3.8 s budget from the request of Gladys (the
  queue included); a command with no time left is dropped, never sent late.
  The ack waits for the broker's acknowledgement (QoS 2, as lghorizon), never
  for a publication to Gladys (states go out in the background). No broker
  acknowledgement within the budget: "sent, without confirmation" and the UI
  status is asked again.
- A 429 pauses every REST path (login, renewal, lookups, MQTT token, start),
  1 min to 6 h, kept in `/data` and bounded when read back. Commands over an
  open live link still work during a pause: they go to the MQTT broker, not to
  the REST API that asked to slow down.
- Refusals: 97401, 97402, or a 400/401/403 carrying the service's JSON
  `error`. A 403 without it (CloudFront, proxy) is a passing error. A refused
  refresh token with a password configured falls back to one password login.
  The stop is kept in `/data` against a SHA-256 digest of the credentials
  (never the password): no automatic retry, not on restart, not on a
  reconnection to Gladys, not on a save of the same credentials; new
  credentials or the "Reconnect" button try once.
- Refresh token: rotated at every use, the newest kept in `/data/lg-horizon.json`
  (mode 0600) against the digest of the configured credentials, used after a
  restart instead of the typed one. A `secret` field is kept by Gladys in its
  database, never shown again; the docs never call it encrypted.
- Session renewal by a named timer: `refreshTokenExpiry` minus one day,
  between 10 min and 12 h from now; failures 5, 15, 60 min; refused: stop. A
  401 of an API call renews at most once a minute and retries once.
- Live link: reconnection 30 s, 1, 2, 5, 10, 15 min; the count resets only
  after 2 minutes up (a socket that opens then drops never loops); a refused
  subscription to `<hh>/+/status` closes the link (tried again later).
- A reconnection to Gladys (`connected`) keeps the session, the pauses, the
  refusal and the client; it publishes the status, the Discovery and the last
  states again (status cache cleared, `forgetPublishedStates`).
- Discovery: the boxes of the customer answer, kept in `/data` so they are
  published again while the cloud is down; a box gone from the account but
  created in Gladys stays known. Every publication starts from the device
  created in Gladys (`gladys.devices`) and adds back its features: a device
  never loses a feature.
- External ids: `gladys.externalIds('box', <deviceId>)`; feature keys frozen
  (`src/constants.js`).
- Program lookups (replay event, VOD, recording) are secondary: a failure
  publishes the channel with "—" as program. Results cached (200 entries).
- Untrusted ids (box, channel, household, profile) must be plain identifiers,
  never `__proto__`/`constructor`/`prototype`; tables without prototype or
  Maps; MQTT topics outside the household are ignored; answers capped (8 MB
  REST, 64 KB auth and MQTT).
- Version 0.1.0 in `package.json`, `package-lock.json`, the manifest and the
  `docker_image` tag, set by hand at milestone 1: the one exception to
  "versions belong to the Release workflow", because the template's 1.0.0 and
  its image were someone else's. The first patch release gives 0.1.1.

### Review fixes (2026-10-18)

- The playback state is forgotten when the live link drops or the session
  ends: play/pause is refused until a UI status arrives again.
- A UI status sets the playback state and ends the play guard at once,
  before any lookup; the lookups only fill the channel and the program.
- A refresh token received is never thrown away: the session always hands it
  over, even once closed, and the app keeps it while the credentials it came
  from are still configured. The stored token is read at each renewal (a
  getter), and a restart of the session with the same credentials ("Reconnect")
  waits first for a renewal in flight (at most `httpTimeout`).
- /data writes go through a chained queue, each to its own temporary file,
  flushed (`FileHandle.sync()`) before the rename; `stop()` waits for the
  queue.
- A 429 of a login or renewal (`ensure`, the renewal after a 401) pauses
  everything like any other 429; the live link credentials pause too.
- A renewal after a 401 that did not end it spaces the next one: 1 min, then
  15 min, then 1 h (back to 1 min once a call goes through).
- Any refusal of the refresh endpoint is reported as a refused token.
- The credential digest is scrypt (N 16384, r 8, p 1) with a random 16-byte
  salt kept beside it in /data; a /data without salt gets one and drops the
  old refusal and refresh token (no digest to compare them with).
- After the MQTT CONNACK, the SUBACK is awaited `mqttConnectTimeout` (20 s) at
  most, then the connection is closed and tried again later.
- A failed lookup is not asked again for 10 min; lookups run one at a time per
  box, only for the latest UI status (older ones waiting are skipped).
- The live link removes only the listeners it added to an MQTT client.
