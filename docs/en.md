# Edilkamin

Unofficial integration, not affiliated with Edilkamin. It brings into Gladys
the **Edilkamin** pellet stoves linked to the **The Mind** app (the "The Mind"
Wi-Fi module), through the Edilkamin cloud, the one the app uses.

> **Warning: unofficial API, this integration has never been tested with a
> real stove or account.** It was written from the edilkamin.py library and
> tested against a fake Edilkamin cloud only. Edilkamin may change its API at
> any time. Feedback is welcome.

## What you get

For each stove:

| Feature            | Detail                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| Lit (on)           | Read only: 1 on (or lighting), 0 off.                                                             |
| Light the stove    | Button. Off by default (see Safety).                                                              |
| Turn the stove off | Button. Always allowed.                                                                           |
| Room temperature   | In °C, the probe of the stove.                                                                    |
| Setpoint           | In °C, 12 to 30 by steps of 0.5. Changed only if you allow it.                                    |
| Power level        | A choice, P1 to P5 (manual power). Changed only if you allow it.                                  |
| Fan 1 to 3         | The level of each fan (read only), as many as the stove has.                                      |
| Pellets low        | 1 when the pellet tank is in reserve.                                                             |
| Last alarm         | A text, e.g. "Alarm 7 (2026-10-17 21:04 UTC)", when the document of the stove holds an alarm log. |

Scene trigger **Edilkamin stove alarm**: when a read shows more alarms in the
log of the stove than the previous read. Variables: `stove` (the name of the
stove) and `code` (the alarm code, empty when unknown). Never on the first
read after a start.

The cloud gives the pellet level only as "in reserve"; the autonomy it
reports is not published yet (its unit is to check on a real stove).

The badge of each stove shows "cloud", "unreachable" (with an orange dot)
when that stove cannot be read (MAC address unknown or not in the account),
and "unreachable" for all when the cloud does not answer or the account is
stopped.

## Installation

1. Your stoves must work in the **The Mind** app.
2. Note the **MAC address** of each stove: The Mind app shows it, so does the
   label of the Wi-Fi module. The Edilkamin cloud gives no list of the stoves
   of an account: it has to be typed.
3. In Gladys, install the Edilkamin integration, enter the **user name**
   (e-mail) and the **password** of The Mind app, and the MAC addresses
   separated by commas (`A8:03:2A:12:34:56, A8:03:2A:65:43:21`). Save.
4. Add the stoves from the **Discovery** tab.

## Safety

A pellet stove is a flame appliance:

- **Turning off is always allowed**, without an option, and always sent (on
  a stove already off, it changes nothing). It never waits behind another
  command of the same stove, but for a lighting already on its way, so it
  lands after it. It is also sent during a pause asked by Edilkamin, and
  renews an expired session by itself within its deadline.
- A lighting waiting or in progress is **cancelled** when a turn off arrives
  meanwhile ("turn off asked meanwhile").
- **Lighting** is off by default: turn on **Allow lighting the stoves from
  Gladys** to allow it. A scene or a dashboard can then light a flame in your
  home while nobody is there: check the stove, its glass and its surroundings
  first.
- **There is no switch**: the "Lit" state is read only, and lighting and
  turning off are buttons. An "everything on" or "everything off" of a scene
  never touches the stove, and voice assistants can neither light it nor turn
  it off. HomeKit shows the setpoint as a thermostat stuck on "Heat"; Google
  Home and Alexa do not expose the setpoint.
- **The setpoint and the power level** are off by default (**Allow changing
  the setpoint and the power level from Gladys**). They never send the
  lighting order; on a stove already running but on standby (flame out), a
  higher setpoint makes it start again, as in the app.
- Before lighting, the setpoint and the power level, the integration **reads
  the stove again** from the cloud: the command is refused when that read
  fails or lacks the value. Turning off reads nothing: it has nothing to
  decide.
- The commands of one stove run **one at a time** (but turning off).
- A command that cannot be sent within **3.5 seconds** of its arrival is
  refused: Gladys shows a failure after 5 seconds, and nothing must happen
  after that failure.
- After a power command, a new lighting is refused ("still in progress")
  until a read shows the expected state, 60 seconds at most.
- If Edilkamin does not answer a command in time, Gladys shows a failure, but
  the command may have gone through: check the state of the stove.

## Password, tokens and privacy

- The password is **kept by Gladys in its database, never shown again, and
  sent only to Edilkamin**, to its AWS Cognito sign-in service to be exact, as
  an SRP proof: the password itself never travels.
- The sign-in gives tokens: the token (about one hour) is renewed with the
  refresh token, without the password; the integration does not sign in again
  at each read. The tokens are kept in the `/data` volume of the integration
  so a restart does not sign in again. On the Gladys host, that volume is the
  folder `<Gladys base folder>/external-integrations/<selector>`: readable by
  root and uid 1000 (the user of the container), **not in the Gladys
  backups**, deleted when the integration is uninstalled. **The refresh token
  gives control of the stoves** while it is valid, without the password:
  protect that host. The user name and the password are never written there;
  another user name drops the tokens.
- Nothing reaches the logs: no password, token, user name, nor whole MAC
  address (only its last 4 characters).
- Everything goes over HTTPS to `cognito-idp.eu-central-1.amazonaws.com` (the
  sign-in) and `the-mind-api.edilkamin.com` (the stoves).

## Refresh

The stoves are read every 60 seconds by default (60 to 900), one request per
stove, plus three reads within the minute after a command.

## Errors

- **Password refused** (or account not confirmed, reset required): the
  integration stops; one new try after 1 h, 6 h, then every 24 h, or at once
  when you save the configuration or click **Test the connection**.
- **Verification code, or any other sign-in step** (but a new password): not
  handled. The integration stops and never signs in again by itself (each
  sign-in could send a code); click **Test the connection**, or change the
  user name or the password.
- **Session refused right after a new sign-in**: new try after 1 h, 6 h, then
  every 24 h.
- **Edilkamin asks to slow down** (429, or too many sign-ins): a pause of at
  least 1 minute (Retry-After when given, 6 h at most), for every path but
  turning off, kept across restarts.
- **HTTP 403 on every stove**: a 30-minute pause (with one stove only, check
  its MAC address). A 403, a 404, a 5xx or a timeout on one stove only marks
  that stove ("unreachable" badge); the others are still read.
- **Edilkamin unreachable** (no stove answered): new try after 1, 2, 5, 10, then every 15 minutes,
  never faster than the refresh interval.

## Limits

- Never tested with a real stove: the shape of the answers comes from
  edilkamin.py; the alarm log, the setpoint range and the fan levels are to
  check.
- The MAC addresses have to be typed (10 stoves at most): the Bluetooth
  discovery of edilkamin.py is not possible in the container.
- The chrono, relax, standby, Airkare modes and the easy timer are not
  handled.
- The old ("legacy") Edilkamin API is not used.

## Credits

- [edilkamin.py](https://github.com/AndreMiras/edilkamin.py) by Andre Miras
  (MIT): the cloud API, the sign-in and the stove document are ported to
  JavaScript.
- [pycognito](https://github.com/pvizeli/pycognito) (Apache-2.0): the SRP
  computation.
- See `THIRD_PARTY_NOTICES.md`.

Edilkamin and The Mind are trademarks of Edilkamin; this project is not
affiliated with Edilkamin.
