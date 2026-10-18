// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, button, command refusals, feature
// names, the last alarm of a stove), in English and French.
// -----------------------------------------------------------------------------

/** The text of `texts` in `language`, English otherwise. */
export const word = (texts, language) => texts[language] ?? texts.en;

const both = (en, fr) => ({ en, fr });

/** Two messages one after the other, in each language. */
export const join = (...messages) =>
  both(messages.map((m) => m.en).join(' '), messages.map((m) => m.fr).join(' '));

/** "25 min" / "3 h", for the pauses. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 120) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const DEVICE_NAME = both('Edilkamin stove', 'Poêle Edilkamin');

/** Feature names, in the language chosen in the configuration. */
export const FEATURE_NAMES = {
  power: both('Lit (on)', 'Allumé'),
  'power-on': both('Light the stove', 'Allumer le poêle'),
  'power-off': both('Turn the stove off', 'Éteindre le poêle'),
  temperature: both('Room temperature', 'Température ambiante'),
  setpoint: both('Setpoint', 'Consigne'),
  'power-level': both('Power level', 'Puissance'),
  'fan-1': both('Fan 1', 'Ventilation 1'),
  'fan-2': both('Fan 2', 'Ventilation 2'),
  'fan-3': both('Fan 3', 'Ventilation 3'),
  'pellet-reserve': both('Pellets low (reserve)', 'Granulés en réserve'),
  'last-alarm': both('Last alarm', 'Dernière alarme'),
};

/** The labels of the power level options. */
export const powerLevelLabel = (level) => both(`P${level}`, `P${level}`);

/** The last alarm, as a text: "Alarm 7 (2026-10-17 21:04 UTC)". */
export const ALARM = {
  none: both('No alarm', 'Aucune alarme'),
  code: (code, at) =>
    both(`Alarm ${code}${at ? ` (${at})` : ''}`, `Alarme ${code}${at ? ` (${at})` : ''}`),
  unknown: (count) =>
    both(
      `${count} alarm${count > 1 ? 's' : ''} logged`,
      `${count} alarme${count > 1 ? 's' : ''} enregistrée${count > 1 ? 's' : ''}`,
    ),
};

export const T = {
  noCredentials: both(
    'Enter the user name (e-mail) and the password of your Edilkamin account (the ones of The Mind app), and the MAC address of each stove.',
    "Saisissez l'identifiant (e-mail) et le mot de passe de votre compte Edilkamin (ceux de l'application The Mind), et l'adresse MAC de chaque poêle.",
  ),
  noStoves: both(
    'Enter the MAC address of each stove (shown in The Mind app, or on the label of its Wi-Fi module), separated by commas.',
    "Saisissez l'adresse MAC de chaque poêle (affichée dans l'application The Mind, ou sur l'étiquette de son module Wi-Fi), séparées par des virgules.",
  ),
  connecting: both('Signing in to Edilkamin…', 'Connexion à Edilkamin…'),
  connected: (read, total, invalid) => {
    const skipped =
      invalid > 0
        ? both(
            ` ${invalid} MAC address${invalid > 1 ? 'es' : ''} of the configuration ${invalid > 1 ? 'are' : 'is'} not valid.`,
            ` ${invalid} adresse${invalid > 1 ? 's' : ''} MAC de la configuration ${invalid > 1 ? 'ne sont pas valides' : "n'est pas valide"}.`,
          )
        : both('', '');
    const missing = total - read;
    const lost =
      missing > 0
        ? both(
            ` ${missing} stove${missing > 1 ? 's' : ''} could not be read (see ${missing > 1 ? 'their' : 'its'} badge).`,
            ` ${missing} poêle${missing > 1 ? 's' : ''} n'${missing > 1 ? 'ont' : 'a'} pas pu être lu${missing > 1 ? 's' : ''} (voir ${missing > 1 ? 'leur' : 'son'} badge).`,
          )
        : both('', '');
    return both(
      `Connected to Edilkamin: ${read} stove${read > 1 ? 's' : ''} read. Open Discovery to add ${read > 1 ? 'them' : 'it'}.${lost.en}${skipped.en}`,
      `Connecté à Edilkamin : ${read} poêle${read > 1 ? 's' : ''} lu${read > 1 ? 's' : ''}. Ouvrez Découverte pour ${read > 1 ? 'les ' : "l'"}ajouter.${lost.fr}${skipped.fr}`,
    );
  },
  noneRead: (total) =>
    both(
      `Signed in to Edilkamin, but none of the ${total} MAC address${total > 1 ? 'es' : ''} could be read: check them (The Mind app).`,
      `Connecté à Edilkamin, mais aucune des ${total} adresse${total > 1 ? 's' : ''} MAC n'a pu être lue : vérifiez-les (application The Mind).`,
    ),
  refused: (wait) =>
    both(
      `Edilkamin refused the user name or the password (or the account). Check them in the configuration: saving, or the test button, tries again at once; otherwise one new try in ${wait.en}.`,
      `Edilkamin a refusé l'identifiant ou le mot de passe (ou le compte). Vérifiez-les dans la configuration : enregistrer, ou le bouton de test, réessaie aussitôt ; sinon un nouvel essai dans ${wait.fr}.`,
    ),
  twoFactor: both(
    'Edilkamin asks for a verification code, which this integration does not handle. It never signs in again by itself (each sign-in would send a code): click "Test the connection", or change the user name or the password.',
    "Edilkamin demande un code de vérification, que cette intégration ne gère pas. Elle ne se reconnecte jamais d'elle-même (chaque connexion enverrait un code) : cliquez sur « Tester la connexion », ou changez l'identifiant ou le mot de passe.",
  ),
  newPassword: both(
    'Edilkamin asks for a new password: choose it in The Mind app, then enter it here.',
    "Edilkamin demande un nouveau mot de passe : choisissez-le dans l'application The Mind, puis saisissez-le ici.",
  ),
  unsupportedChallenge: (name) =>
    both(
      `Edilkamin asks for a sign-in step this integration does not handle (${name ?? 'unknown'}). It never tries again by itself: click "Test the connection", or change the user name or the password.`,
      `Edilkamin demande une étape de connexion que cette intégration ne gère pas (${name ?? 'inconnue'}). Elle ne réessaie jamais d'elle-même : cliquez sur « Tester la connexion », ou changez l'identifiant ou le mot de passe.`,
    ),
  sessionRefused: (wait) =>
    both(
      `Edilkamin refused the session again right after a new sign-in. New try in ${wait.en}, or click "Test the connection".`,
      `Edilkamin a de nouveau refusé la session juste après une nouvelle connexion. Nouvel essai dans ${wait.fr}, ou cliquez sur « Tester la connexion ».`,
    ),
  unreachable: (reason, wait) =>
    both(
      `Edilkamin cannot be reached (${reason.en}). Next try in ${wait.en}.`,
      `Edilkamin est injoignable (${reason.fr}). Nouvel essai dans ${wait.fr}.`,
    ),
  rateLimited: (wait) =>
    both(
      `Edilkamin asks to slow down: pausing for ${wait.en}.`,
      `Edilkamin demande de ralentir : pause de ${wait.fr}.`,
    ),
  forbidden: (wait) =>
    both(
      `Edilkamin refuses the requests (HTTP 403): pausing for ${wait.en}.`,
      `Edilkamin refuse les requêtes (HTTP 403) : pause de ${wait.fr}.`,
    ),
  checkMac: both(
    'Check the MAC address of the stove in the configuration (The Mind app).',
    "Vérifiez l'adresse MAC du poêle dans la configuration (application The Mind).",
  ),
  stoveNoAnswer: both(
    'Edilkamin did not answer for this stove at the last read (an error or a timeout of the cloud).',
    "Edilkamin n'a pas répondu pour ce poêle à la dernière lecture (erreur ou délai dépassé du cloud).",
  ),
  stoveUnreadable: both(
    'This stove could not be read (unknown MAC address, not in this account, or a bad answer).',
    "Ce poêle n'a pas pu être lu (adresse MAC inconnue, absente de ce compte, ou réponse invalide).",
  ),
  busy: both(
    'A read of Edilkamin is in progress: try again in a minute.',
    'Une lecture d’Edilkamin est en cours : réessayez dans une minute.',
  ),
  test: {
    cooldown: both(
      'Already read less than 30 seconds ago.',
      'Déjà lu il y a moins de 30 secondes.',
    ),
  },
  denied: {
    noConfig: both(
      'The Edilkamin account is not configured.',
      "Le compte Edilkamin n'est pas configuré.",
    ),
    powerOn: both(
      'Lighting the stove from Gladys is turned off: allow it in the configuration of the integration. Turning it off is always allowed.',
      "L'allumage du poêle depuis Gladys est désactivé : autorisez-le dans la configuration de l'intégration. L'extinction est toujours permise.",
    ),
    commands: both(
      'The setpoint and the power level cannot be changed from Gladys: allow it in the configuration of the integration.',
      "La consigne et la puissance ne peuvent pas être changées depuis Gladys : autorisez-le dans la configuration de l'intégration.",
    ),
    stopped: both(
      'The Edilkamin account is not connected (see the status of the integration): command refused.',
      "Le compte Edilkamin n'est pas connecté (voir l'état de l'intégration) : commande refusée.",
    ),
    paused: both(
      'Edilkamin asked to slow down: command refused during the pause.',
      'Edilkamin a demandé de ralentir : commande refusée pendant la pause.',
    ),
    forbidden: both(
      'Edilkamin refuses the requests (HTTP 403): command refused during the 30-minute pause.',
      'Edilkamin refuse les requêtes (HTTP 403) : commande refusée pendant la pause de 30 minutes.',
    ),
    badButton: both(
      'Unexpected value: this button only accepts 1.',
      "Valeur inattendue : ce bouton n'accepte que 1.",
    ),
    badSetpoint: (min, max, step) =>
      both(
        `Unexpected setpoint: a temperature from ${min} to ${max} °C, by steps of ${step} °C.`,
        `Consigne inattendue : une température de ${min} à ${max} °C, par pas de ${String(step).replace('.', ',')} °C.`,
      ),
    badPowerLevel: (min, max) =>
      both(
        `Unexpected power level: ${min} to ${max}.`,
        `Puissance inattendue : de ${min} à ${max}.`,
      ),
    session: both(
      'The Edilkamin session is being renewed: try again in a few seconds.',
      'La session Edilkamin est en cours de renouvellement : réessayez dans quelques secondes.',
    ),
    unknownDevice: both(
      'This stove is not (or no longer) in the configuration of the integration.',
      "Ce poêle n'est pas (ou plus) dans la configuration de l'intégration.",
    ),
    inProgress: both(
      'A power command of this stove is still in progress: lighting refused.',
      'Une commande de marche de ce poêle est encore en cours : allumage refusé.',
    ),
    unreadable: both(
      'The state of the stove could not be read again just before acting: command refused.',
      "L'état du poêle n'a pas pu être relu juste avant d'agir : commande refusée.",
    ),
    unknown: both(
      'The stove did not report whether it is on: command refused.',
      "Le poêle n'a pas indiqué s'il est allumé : commande refusée.",
    ),
    sessionLost: both(
      'The Edilkamin session could not be renewed: turning off not sent. The integration signs in again by itself; see its status.',
      "La session Edilkamin n'a pas pu être renouvelée : extinction non envoyée. L'intégration se reconnecte d'elle-même ; voir son état.",
    ),
    offMeanwhile: both(
      'A turn off of this stove was asked meanwhile: lighting refused.',
      'Extinction demandée entre-temps : allumage refusé.',
    ),
    late: both(
      'Edilkamin answered too late: command refused before acting (nothing was sent).',
      "Edilkamin a répondu trop tard : commande refusée avant d'agir (rien n'a été envoyé).",
    ),
  },
  maybeSent: (reason) =>
    both(
      `The command may have reached Edilkamin, but it did not confirm it (${reason.en}). Check the state of the stove.`,
      `La commande a pu atteindre Edilkamin, mais il ne l'a pas confirmée (${reason.fr}). Vérifiez l'état du poêle.`,
    ),
  commandFailed: (reason) =>
    both(
      `Edilkamin refused the command (${reason.en}).`,
      `Edilkamin a refusé la commande (${reason.fr}).`,
    ),
};

/** The reason of an error, by kind, in both languages (never an English text in French). */
const REASONS = {
  network: both('network error', 'erreur réseau'),
  timeout: both('no answer in time', 'pas de réponse à temps'),
  unavailable: both('Edilkamin unavailable', 'Edilkamin indisponible'),
  bad_response: both('unexpected answer', 'réponse inattendue'),
  size: both('answer too large', 'réponse trop grande'),
  not_found: both('not found', 'introuvable'),
  forbidden: both('refused', 'refusé'),
  rate_limited: both('too many requests', 'trop de requêtes'),
  unauthorized: both('session refused', 'session refusée'),
  session_refused: both('session refused', 'session refusée'),
  http: both('request failed', 'requête en échec'),
};

/** `{ en, fr }`: the reason of an error, with its HTTP status when there is one. */
export function reasonOf(err) {
  const reason = REASONS[err?.kind] ?? both('error', 'erreur');
  const status = Number.isInteger(err?.status) ? `, HTTP ${err.status}` : '';
  return both(`${reason.en}${status}`, `${reason.fr}${status}`);
}
