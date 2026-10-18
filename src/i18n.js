// -----------------------------------------------------------------------------
// The texts users read in Gladys (connection status, the configuration
// button, command errors), in English and French.
// -----------------------------------------------------------------------------

const both = (en, fr) => ({ en, fr });

/** "14:05 UTC" for a time in ms. */
const clock = (ms) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

/** "5 min", "2 h". */
export function duration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

export const T = {
  missing: (operatorName, auth) =>
    auth === 'refresh_token'
      ? both(
          `${operatorName}: paste the refresh token of your account in the configuration (see the guide).`,
          `${operatorName} : collez le jeton de rafraîchissement (refresh token) de votre compte dans la configuration (voir le guide).`,
        )
      : both(
          `${operatorName}: type the user name and password of your account (or a refresh token) in the configuration.`,
          `${operatorName} : saisissez l'identifiant et le mot de passe de votre compte (ou un refresh token) dans la configuration.`,
        ),
  refused: (reason) =>
    reason === 'token'
      ? both(
          'The operator refused the refresh token (expired or replaced). Paste a new one in the configuration, then save. Gladys does not try again by itself.',
          "L'opérateur a refusé le jeton de rafraîchissement (expiré ou remplacé). Collez-en un nouveau dans la configuration, puis enregistrez. Gladys ne réessaie pas tout seul.",
        )
      : both(
          'The operator refused the user name or the password. Fix them in the configuration and save, or click "Reconnect" once fixed on the operator side. Gladys does not try again by itself (a password tried again and again can lock the account).',
          "L'opérateur a refusé l'identifiant ou le mot de passe. Corrigez-les dans la configuration et enregistrez, ou cliquez sur « Se reconnecter » une fois le problème réglé chez l'opérateur. Gladys ne réessaie pas tout seul (un mot de passe essayé encore et encore peut bloquer le compte).",
        ),
  paused: (until) =>
    both(
      `The operator's cloud asked to slow down (429): paused until ${clock(until)}.`,
      `Le cloud de l'opérateur demande de ralentir (429) : en pause jusqu'à ${clock(until)}.`,
    ),
  retrying: (error, wait) =>
    both(
      `The operator's cloud does not answer as expected (${error}): next try in ${duration(wait)}.`,
      `Le cloud de l'opérateur ne répond pas comme prévu (${error}) : nouvel essai dans ${duration(wait)}.`,
    ),
  connecting: both('Connecting to the operator…', 'Connexion à l’opérateur…'),
  liveDown: (wait) =>
    wait === undefined
      ? both(
          'Connected to the account; the live link with the boxes is opening.',
          'Connecté au compte ; la liaison en direct avec les décodeurs est en cours d’ouverture.',
        )
      : both(
          `Connected to the account, but the live link with the boxes is down: next try in ${duration(wait)}.`,
          `Connecté au compte, mais la liaison en direct avec les décodeurs est coupée : nouvel essai dans ${duration(wait)}.`,
        ),
  connected: (count) =>
    both(
      `Connected: ${count} box(es) on the account.`,
      `Connecté : ${count} décodeur(s) sur le compte.`,
    ),
  noBox: both(
    'Connected, but the account lists no set-top box.',
    'Connecté, mais le compte ne liste aucun décodeur.',
  ),
  noChannels: both(
    'The channel list could not be read: channel names are missing for now.',
    'La liste des chaînes n’a pas pu être lue : les noms de chaînes manquent pour l’instant.',
  ),
  dataReset: both(
    'The saved data was unreadable and was reset.',
    'Les données enregistrées étaient illisibles et ont été réinitialisées.',
  ),
  reconnectRefusedAgain: both(
    'Tried once: the operator still refuses the credentials.',
    'Essai unique : l’opérateur refuse toujours les identifiants.',
  ),
};

/** Messages of the commands, in English (Gladys shows the error of the ack as is). */
export const E = {
  unknownBox: 'Unknown set-top box',
  notCommand: (key) => `"${key}" cannot be commanded`,
  blocked: 'The operator refused the credentials: nothing sent (see the configuration)',
  notReady: 'Not connected to the operator yet: nothing sent',
  liveDown: 'Live link with the boxes down: nothing sent',
  stateUnknown: 'State of the box unknown (offline or not reported yet): nothing sent',
  notRunning: 'The box is not running (standby or offline): nothing sent',
  powerBusy: 'A power command is already under way: ignored',
  playBusy: 'A play/pause command is already under way: ignored',
  playbackUnknown: 'Playback state unknown: nothing sent',
  late: 'No time left for this command: nothing sent',
};
