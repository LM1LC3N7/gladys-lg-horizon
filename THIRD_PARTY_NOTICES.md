# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the project below, under its own licence.

## lghorizon

- Project: [Sholofly/lghorizon-python](https://github.com/Sholofly/lghorizon-python),
  version 0.12.2, the Python library of the LG Horizon integration of Home
  Assistant.
- What is ported (rewritten in JavaScript in `src/constants.js` and
  `src/horizon/`): the operators and their API addresses, the login and
  refresh requests and their error codes, the backoffice configuration and the
  REST paths (customer, channels, replay events, VOD, recordings, MQTT token),
  the MQTT connection (household id and MQTT token, client id, topics, the
  status announced by the client), the message types (`CPE.uiStatus`,
  `CPE.getUiStatus`, `CPE.KeyEvent`), the remote key names, the running states
  and the reading of the UI status (sources, launcher overlays).
- Licence: MIT. The licence file of the project reads:

```
Copyright (c) 2021 Rudolf Offereins

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Runtime dependency

[MQTT.js](https://github.com/mqttjs/MQTT.js) (`mqtt`, MIT) is installed from
npm as a dependency, with its own licence in `node_modules/mqtt/LICENSE.md`;
none of its code is copied here.
