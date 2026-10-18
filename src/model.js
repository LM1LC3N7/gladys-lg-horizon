// -----------------------------------------------------------------------------
// Boxes -> Gladys devices and states (pure). One device per set-top box,
// keyed by the deviceId the cloud gives it.
//
// No switch, nothing an "everything on / off" (voice assistants, scenes
// `switch.*`) could turn into a command: the power state is read only
// (`unknown/binary`), standby and wake-up are two push buttons. Play, pause
// and the channel keys are the `television` types, which Gladys shows as push
// buttons. No volume: the cloud API has no volume key. No unit: the core
// lists none for these categories.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { BOX_STATES, DEVICE_TYPE, FEATURES, NOTHING } from './constants.js';

const NAMES = {
  [FEATURES.POWER]: { en: 'Power', fr: 'Allumé' },
  [FEATURES.ONLINE]: { en: 'Reachable', fr: 'Joignable' },
  [FEATURES.WAKE]: { en: 'Wake up', fr: 'Allumer' },
  [FEATURES.STANDBY]: { en: 'Standby', fr: 'Mettre en veille' },
  [FEATURES.PLAY]: { en: 'Play', fr: 'Lecture' },
  [FEATURES.PAUSE]: { en: 'Pause', fr: 'Pause' },
  [FEATURES.CHANNEL_UP]: { en: 'Next channel', fr: 'Chaîne suivante' },
  [FEATURES.CHANNEL_DOWN]: { en: 'Previous channel', fr: 'Chaîne précédente' },
  [FEATURES.CHANNEL]: { en: 'Channel', fr: 'Chaîne' },
  [FEATURES.PROGRAM]: { en: 'Program', fr: 'Programme' },
  [FEATURES.PLAYBACK]: { en: 'Playing', fr: 'En lecture' },
};

const readOnly = { read_only: true, has_feedback: false };
const button = (category, type) => ({ category, type, min: 0, max: 1 });

/** The feature definitions, by frozen key, in the order they are published. */
export const FEATURE_SPECS = Object.freeze({
  [FEATURES.POWER]: {
    category: C.UNKNOWN,
    type: T.SENSOR.BINARY,
    min: 0,
    max: 1,
    keep_history: true,
    ...readOnly,
  },
  [FEATURES.ONLINE]: {
    category: C.UNKNOWN,
    type: T.SENSOR.BINARY,
    min: 0,
    max: 1,
    keep_history: true,
    ...readOnly,
  },
  [FEATURES.WAKE]: button(C.BUTTON, T.BUTTON.PUSH),
  [FEATURES.STANDBY]: button(C.BUTTON, T.BUTTON.PUSH),
  [FEATURES.PLAY]: button(C.TELEVISION, T.TELEVISION.PLAY),
  [FEATURES.PAUSE]: button(C.TELEVISION, T.TELEVISION.PAUSE),
  [FEATURES.CHANNEL_UP]: button(C.TELEVISION, T.TELEVISION.CHANNEL_UP),
  [FEATURES.CHANNEL_DOWN]: button(C.TELEVISION, T.TELEVISION.CHANNEL_DOWN),
  [FEATURES.CHANNEL]: { category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, ...readOnly },
  [FEATURES.PROGRAM]: { category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, ...readOnly },
  [FEATURES.PLAYBACK]: {
    category: C.MUSIC,
    type: T.MUSIC.PLAYBACK_STATE,
    min: 0,
    max: 1,
    ...readOnly,
  },
});

/** The keys a command may target. */
export const COMMANDS = new Set([
  FEATURES.WAKE,
  FEATURES.STANDBY,
  FEATURES.PLAY,
  FEATURES.PAUSE,
  FEATURES.CHANNEL_UP,
  FEATURES.CHANNEL_DOWN,
]);

export const deviceName = (box) => box.name || `LG Horizon ${box.id}`;

/**
 * The Gladys device of a box. `created` (the device as Gladys has it, from
 * `gladys.devices`) adds back any feature of the created device this list
 * would not have: a device published again never loses a feature.
 */
export function buildDevice(gladys, box, language = 'fr', created = undefined) {
  const ids = gladys.externalIds(DEVICE_TYPE, box.id);
  const features = Object.entries(FEATURE_SPECS).map(([key, spec]) => ({
    name: NAMES[key][language] ?? NAMES[key].en,
    external_id: ids.feature(key),
    read_only: false,
    has_feedback: false,
    keep_history: false,
    ...spec,
  }));
  const known = new Set(features.map((f) => f.external_id));
  for (const feature of Array.isArray(created?.features) ? created.features : []) {
    if (feature && typeof feature.external_id === 'string' && !known.has(feature.external_id)) {
      known.add(feature.external_id);
      features.push({ ...feature });
    }
  }
  return {
    name: deviceName(box),
    external_id: ids.device,
    should_poll: false,
    features,
  };
}

/** The feature key of a feature external id of `device`, or undefined. */
export function featureKey(deviceExternalId, featureExternalId) {
  const prefix = `${deviceExternalId}:`;
  return String(featureExternalId ?? '').startsWith(prefix)
    ? String(featureExternalId).slice(prefix.length)
    : undefined;
}

/**
 * The states of a box view `{ state, channel?, program?, playing? }`. An
 * unknown running state publishes nothing.
 */
export function stateList(gladys, box, view) {
  const state = view?.state;
  if (!state || state === BOX_STATES.UNKNOWN) {
    return [];
  }
  const ids = gladys.externalIds(DEVICE_TYPE, box.id);
  const id = (key) => ids.feature(key);
  const running = state === BOX_STATES.RUNNING;
  const online = running || state === BOX_STATES.STANDBY;
  const states = [
    { device_feature_external_id: id(FEATURES.POWER), state: running ? 1 : 0 },
    { device_feature_external_id: id(FEATURES.ONLINE), state: online ? 1 : 0 },
  ];
  if (!running) {
    states.push(
      { device_feature_external_id: id(FEATURES.CHANNEL), text: NOTHING },
      { device_feature_external_id: id(FEATURES.PROGRAM), text: NOTHING },
      { device_feature_external_id: id(FEATURES.PLAYBACK), state: 0 },
    );
    return states;
  }
  if (view.channel !== undefined) {
    states.push({
      device_feature_external_id: id(FEATURES.CHANNEL),
      text: view.channel || NOTHING,
    });
  }
  if (view.program !== undefined) {
    states.push({
      device_feature_external_id: id(FEATURES.PROGRAM),
      text: view.program || NOTHING,
    });
  }
  if (typeof view.playing === 'boolean') {
    states.push({ device_feature_external_id: id(FEATURES.PLAYBACK), state: view.playing ? 1 : 0 });
  }
  return states;
}
