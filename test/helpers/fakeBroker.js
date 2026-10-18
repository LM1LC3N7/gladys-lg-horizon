// -----------------------------------------------------------------------------
// A fake MQTT broker behind the `connect` of src/horizon/live.js: each
// connection is an EventEmitter shaped like an MQTT.js client. The tests
// accept or drop connections, deliver messages and read what was published.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';

class FakeClient extends EventEmitter {
  constructor(broker, url, options) {
    super();
    this.broker = broker;
    this.url = url;
    this.options = options;
    this.subscriptions = [];
    this.ended = false;
  }

  accept() {
    if (!this.ended) {
      this.emit('connect', {});
    }
  }

  subscribe(topic, _options, callback) {
    this.subscriptions.push(topic);
    const refused = this.broker.refuseStatus && String(topic).endsWith('/+/status');
    setImmediate(() => callback?.(refused ? new Error('Subscribe error: Not authorized') : null));
  }

  publish(topic, payload, options, callback) {
    this.broker.published.push({ topic, payload: JSON.parse(payload), options });
    if (this.broker.ackPublishes) {
      setImmediate(() => callback?.());
    }
  }

  end() {
    if (this.ended) {
      return;
    }
    this.ended = true;
    setImmediate(() => this.emit('close'));
  }

  /** The broker closes the connection. */
  drop() {
    this.ended = true;
    this.emit('close');
  }
}

export function fakeBroker({ autoAccept = true } = {}) {
  const broker = {
    connections: [],
    published: [],
    ackPublishes: true,
    refuseStatus: false,
    autoAccept,
  };
  broker.connect = (url, options) => {
    const client = new FakeClient(broker, url, options);
    broker.connections.push(client);
    if (broker.autoAccept) {
      setImmediate(() => client.accept());
    }
    return client;
  };
  broker.current = () => broker.connections.findLast((c) => !c.ended);
  broker.deliver = (topic, message) =>
    broker.current()?.emit('message', topic, Buffer.from(JSON.stringify(message)));
  /** The remote keys published, as `[topic, w3cKey]`. */
  broker.keys = () =>
    broker.published
      .filter((p) => p.payload?.type === 'CPE.KeyEvent')
      .map((p) => [p.topic, p.payload.status.w3cKey]);
  return broker;
}
