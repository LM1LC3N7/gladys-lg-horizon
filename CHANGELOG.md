# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- LG Horizon set-top boxes of Ziggo, Telenet, BASE, Sunrise, Virgin Media (UK
  and Ireland) and UPC Poland accounts, through the operator's cloud: a
  JavaScript port of lghorizon 0.12.2 (MIT). Magenta TV (Austria) is not
  supported (never in lghorizon).
- Login with the user name and password, or with a refresh token; the newest
  refresh token is kept in `/data`. Session renewed by a timer.
- Refused credentials stop the integration, across restarts too, without any
  automatic retry; new credentials or the "Reconnect" button try once.
- 429 pauses (1 minute to 6 hours) kept across restarts; growing delays after
  network or server errors.
- Live link over MQTT (secure WebSocket) with spaced reconnections that never
  loop on a socket that opens then drops.
- Per box: power and reachability (read only), channel, program, playing or
  paused; push buttons to wake up, put in standby, play, pause, next and
  previous channel. No volume (the cloud has no volume key).
- Power and play/pause keys sent only toward the opposite of the state the box
  reported live, and guarded until the box reports the expected state.
- Status and Discovery published again at every connection to Gladys; a
  device published again keeps every feature of the created one.
- Feature names in French or English.
- `LICENSE` (Apache-2.0) and `THIRD_PARTY_NOTICES.md` (lghorizon, MIT), copied
  into the image.

[Unreleased]: https://github.com/LM1LC3N7/gladys-lg-horizon/commits/main
