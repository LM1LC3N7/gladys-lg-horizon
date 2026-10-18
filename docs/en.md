# LG Horizon for Gladys

This integration brings the **LG Horizon** set-top boxes (Mediabox Next, Next
Mini, TV Box, 360 Box…) of your operator account into Gladys, through the
operator's cloud: the same API (REST and MQTT) as the app and the web TV site.

> **Warning: this integration has never been tested with a real account.** It
> was written from the lghorizon library and tested against simulated answers
> only. Feedback is welcome on the Gladys forum.

Unofficial, not affiliated with LG, Liberty Global or the operators named here.

## Operators

| Operator               | Country        | Login                  |
| ---------------------- | -------------- | ---------------------- |
| Ziggo                  | Netherlands    | user name and password |
| Telenet                | Belgium        | refresh token          |
| BASE TV                | Belgium        | refresh token          |
| Sunrise (formerly UPC) | Switzerland    | refresh token          |
| Virgin Media           | United Kingdom | refresh token          |
| Virgin Media           | Ireland        | user name and password |
| UPC                    | Poland         | user name and password |

What the reference library tells (lghorizon 0.12.2, October 2026):

- **Ziggo** and **Telenet** are the most followed: recent fixes (July 2026 for
  Ziggo) and issues opened in 2026. A Telenet issue of September 2026 reports
  a login that hangs with a refresh token, unsolved so far.
- **Sunrise** and **Virgin Media (UK and Ireland)** had refused logins early in
  2026, fixed since according to the closed issues.
- **BASE TV** and **UPC Poland** are in the code without recent feedback.
- **Magenta TV (Austria) is not supported**: it was never in lghorizon (no API
  address known for it), and no issue mentions it.

## Configuration

1. Choose your **operator**.
2. Depending on the operator:
   - **Ziggo, Virgin Media Ireland, UPC**: type the **user name** (often the
     e-mail address) and the **password** of the account.
   - **Telenet, BASE, Sunrise, Virgin Media UK**: paste a **refresh token**,
     see below.
3. Save. The boxes of the account show in the **Discovery** tab: add the ones
   you want.

The password and the token are kept by Gladys in its database, never shown
again, and sent only to the auth service of your operator.

### Getting a refresh token

1. On a computer, open the web TV site of your operator (for example
   telenet.tv, sunrisetv.ch, virgintvgo.virginmedia.com) and log in.
2. Open the developer tools of the browser (F12), **Application** tab (Chrome,
   Edge) or **Storage** (Firefox), then the **Local storage** of the site.
3. Copy the value of the key that holds `refreshToken` (for example
   `flutter._WEB_SECURE_STORAGE_refreshToken` on some sites).
4. Paste it in the **Refresh token** field and save.

The token changes at every use: the integration keeps the newest one in its
`/data` volume (a file only the integration can read) and uses it after a
restart. Logging out of the web site may end the token: paste a new one then.

## What each box shows

| Feature                        | Kind      | Values                                                            |
| ------------------------------ | --------- | ----------------------------------------------------------------- |
| Power                          | read only | 1 running, 0 standby or offline                                   |
| Reachable                      | read only | 1 reachable through the cloud (running or standby), 0 offline     |
| Channel                        | text      | name of the channel shown, "—" otherwise                          |
| Program                        | text      | title (and episode) of the program, VOD, recording or application |
| Playing                        | read only | 1 playing, 0 paused or off                                        |
| Wake up                        | button    | leaves standby                                                    |
| Standby                        | button    | goes to standby                                                   |
| Play, Pause                    | buttons   | resume, pause                                                     |
| Next channel, Previous channel | buttons   | change the channel                                                |

No **volume**: the operator's cloud has no volume key (the volume is set on the
TV).

Feature names are in French or English, following the "Language of the
feature names" option.

## Commands

The box only knows one power key (a toggle) and one play/pause key (a toggle).
So that a press never does the opposite of what was asked:

- the key is sent only when the state the box reported live is the opposite
  of the one asked ("Wake up" on a running box does nothing);
- when the state is unknown (box offline, live link down, or no state received
  yet), nothing is sent and Gladys shows an error;
- after a press, any other power command is ignored until the box reports
  the new state (45 s at most); the same for play/pause (10 s at most).

Power and standby are **buttons**, not a switch: an "everything off" of a voice
assistant or a scene cannot trigger them.

## Status and errors

- **Credentials refused**: the integration stops and does not try again by
  itself (a password tried again and again can lock the account). The stop is
  kept across restarts. Fix the configuration (new credentials are tried at
  once) or click **Reconnect** (a single attempt).
- **Too many requests (429)**: a pause of 1 minute to 6 hours, kept across
  restarts.
- **Cloud unreachable**: tried again after 1, 2, 5, 15 then 30 minutes.
- **Live link down**: tried again after 30 s, 1, 2, 5, 10 then 15 minutes; a
  link that opens then drops at once never loops.

The session is renewed by a timer, one day before the refresh token expires
(every 12 hours at most).

## Privacy

The integration only talks to the cloud of your operator: over HTTPS for the
API and over a secure WebSocket (TLS) for MQTT. It reads the list of boxes, the
channel list and the title of what is watched; it sends nothing but the keys
asked.

## Credits

JavaScript port of [lghorizon](https://github.com/Sholofly/lghorizon-python)
(MIT), the library of the Home Assistant integration.
