# TODO — Edilkamin v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum topic of its own, no forum post from a module session.

## Status

- [x] **Milestone 1 — core** (2026-10-18): Cognito SRP sign-in (checked
      against pycognito and a fake Cognito running the server half), id token
      as the bearer, refresh token renewal by a timer, tokens in `/data`;
      stoves from typed MAC addresses, `GET device/{mac}/info` every 60 s
      (60–900) with gzip Buffer fields inflated; features power (read only),
      power-on / power-off buttons, temperature, setpoint, power-level, fans,
      pellet-reserve, last-alarm; scene trigger stove_alarm; safety rules
      (no switch, `allow_power_on` and `allow_commands` off, turning off
      always allowed and never queued, fresh read before acting, 3.5 s
      deadline, one command at a time per stove, power guard); stops and
      pauses persisted and capped; badges; test button; en/fr; docs; cover.
      Tested against a fake cloud only (Node 22 and 24). Store validator:
      its only error is the `docker_image` not yet pullable from GHCR (no
      release yet). No Docker on this PC: the image build is left to the CI.
- [x] **Review fixes** (2026-10-18, extra review of 270063f): turning off
      always sent and counted at its arrival (a queued or reading lighting is
      refused), waits only for a lighting PUT in flight; renewals go on during
      an API pause, turning off renews within its deadline and on a 401;
      per-stove 5xx/timeouts; every unknown challenge stops for good; texts.
- [ ] **Milestone 2 — real stove**: run against a real account and stove,
      compare with The Mind app (see "To check"); turn the answers
      (anonymized) into fixtures.
- [ ] **Milestone 3 — more**: autonomy (`status.pellet.autonomy_time`, once
      its unit is known), operational phase and actual power (if the document
      has them), alarm codes as texts, chrono / standby / relax / Airkare /
      easy timer (read, then commands behind `allow_commands`), fan levels as
      commands, the device name from the account (`register_device` /
      `edit_device` hint at one).
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, GHCR package public.

## To check on a real account

- The sign-in: `USER_SRP_AUTH` with the user name as typed (e-mail? case?),
  `PASSWORD_VERIFIER`, no code challenge; the lifetime of the id token and of
  the refresh token; that the API takes the **id token** (edilkamin.py says so
  for the new API) and answers 401 on an expired one.
- `GET device/{mac}/info`: which fields come as gzip Buffers, the presence and
  the shape of `nvm.alarms_log` (`number`, `alarms[].type`,
  `alarms[].timestamp` in seconds?), the meaning of `status.commands.power`
  while lighting and while cooling down (does it turn 0 at once on a power
  off?), the answer for a MAC of another account (403 or 404?).
- `PUT mqtt/command`: its answer (a JSON string "Command … executed
  successfully" / "Value is already x"), the time the stove takes to show a
  change in the next `GET` (the guard lasts 60 s, the follow-up reads are at
  5, 15 and 45 s), whether a command to an offline stove answers an error.
- The setpoint range and step of the app (12–30 °C by 0.5 here), the fan
  levels (0 to 6 accepted here: is 6 "auto"?), `fans_number` values.
- Rate limits: none documented; a 429 or a 403 of a CDN may come.

## Decisions

- **Not a duplicate** (checked for lot 7, 2026-10-18): no Edilkamin service in
  the Gladys core, none in the integration store; reserved in post 262 of the
  forum thread 10385.
- **Reference reused: AndreMiras/edilkamin.py 1.7.0** (MIT, maintained, the
  library of the Home Assistant integrations), with **pycognito**
  (Apache-2.0) for SRP. Neither runs in a Node container: ported, credited in
  the README and `THIRD_PARTY_NOTICES.md` (with the full MIT notice). The SRP
  code is the one reviewed and approved in gladys-schlage (same pycognito
  port), without the `SECRET_HASH` (the Edilkamin app client has no secret).
  Only runtime dependency: the SDK.
- **Neighbour module**: LM1LC3N7/gladys-toshiba-ac (structure, text/select
  for a mode list) and gladys-schlage (Cognito SRP, safety of a physical
  command, persisted pauses and stops).
- **A flame appliance is never a switch** (Louis, lot 6 lesson): `power` is
  `unknown/binary` read only; lighting and turning off are two
  `button/push` features (value 1 only). Google Home, Alexa, HomeKit, MCP and
  `switch.*` scenes can neither light nor turn off a stove ("everything on" /
  "everything off"). The power level is a `text/select` (P1–P5), not a
  dimmer; the setpoint is a `thermostat/target-temperature` without any
  thermostat mode feature (a mode "heat" from a voice assistant could light
  it): HomeKit shows a thermostat stuck on "Heat", Google and Alexa do not
  expose the setpoint (review M5, said in the docs).
- **The setpoint never sends the lighting order** (review I4): but on a stove
  already running on standby (flame out), a higher setpoint makes it start
  again, as in the app. Said in the manifest and the docs; no stronger claim.
- **Turning off is always allowed** (brief): no option; it does not join the
  per-stove command chain (an emergency stop never waits, lot 6 lesson); it is
  sent during a 429/403 pause and during a stop (one request; safety over
  politeness). It is still never sent after the 3.4 s deadline.
- **Turning off decides nothing, so it reads nothing** (review B1): `power` 0
  is always sent (the cloud answers "Value is already 0" on a stove already
  off), never answered "already off": that shortcut acknowledged a turn off
  while a lighting was queued or reading, and the stove then lit.
- **A turn off cancels a pending lighting** (review B1): a per-stove counter
  is incremented synchronously when the turn off arrives in `setValue`; the
  lighting takes the counter at its own arrival (before the queue) and checks
  it before its read, after it, and synchronously right before its PUT;
  changed, it is refused ("extinction demandée entre-temps"). A lighting PUT
  already in flight is waited for by the turn off, until the turn off's own
  deadline (3.4 s minus 0.3 s), then the turn off is sent whatever happened,
  so it lands after the lighting.
- **Turning off finds a token** (review I1): the pauses remember their source
  (`api` or `cognito`, kept in /data). A pause of the Edilkamin API (429, or
  403 on every stove) no longer stops the renewal timer; only a Cognito 429
  does. When the token is valid less than 10 s, turning off renews it from the
  refresh token within its deadline (the Cognito request bounded by the time
  left) and sends. A 401 on a PUT renews the token at once: turning off then
  sends again once within its deadline; the other commands are refused (try
  again).
- **Lighting is off by default** (`allow_power_on`, brief): refused before
  any request. When allowed: the token must be valid 60 s more (no renewal
  inside the deadline), a fresh read must say the stove is off (`power`
  missing or odd: refused), no guard, `allow_power_on` and the stop checked
  again after the read. An alarm does not refuse lighting for now: no field
  of edilkamin.py tells an active alarm (only a log); to revisit with a real
  stove.
- **Setpoint and power level off by default** (`allow_commands`, brief):
  refused when the fresh read lacks the current value (never decided on
  memory); "already set" sends nothing. Setpoint accepted 12–30 °C by 0.5
  (a guess on the safe side, to check); values are strict (null, '', true,
  21.3 refused; "21,5" accepted).
- **Power guard**: after a power command (sent or maybe sent), lighting is
  refused until a read at least 4 s later shows the expected state, 60 s at
  most. The setpoint and the
  power level have no guard (absolute values, not toggles).
- **MAC addresses typed by the user** (comma separated, 10 at most): the
  cloud has no "list my stoves" endpoint in edilkamin.py, and its discovery is
  Bluetooth (impossible in the container). Normalized as edilkamin.py
  `format_mac`; invalid entries counted in the status. The external id is the
  MAC (12 hex digits, lower case): stable for the stove's Wi-Fi module.
  Device name "Poêle Edilkamin 3456" (end of the MAC); renamed in Gladys.
- **Per-stove errors** (review I2): a 404, a 403, a 5xx, a timeout, another
  HTTP error, a bad or too big document marks only that stove (degraded
  unreachable badge, last values kept) and the loop goes on; the cycle ends
  "unreachable" (backoff) only when no stove answered. A 403 on every stove of
  a cycle is a 30-minute pause (a WAF), so one wrong MAC never pauses the
  others; with one stove only, the status asks to check its MAC (review M4).
  Network, 429 and session errors end the cycle for all. `http` left the
  OFFLINE set (an answer came).
- **User name kept as typed** (trimmed, not lower-cased): Cognito user names
  may be case-sensitive; to check.
- **Challenges not handled** (review I3): Edilkamin accounts are not known to
  use MFA; any Cognito challenge but `NEW_PASSWORD_REQUIRED` (a code, at the
  first step or after the password proof, or any other step) is a stop with no
  automatic retry (each sign-in could send a code). Only the test button, or
  new credentials, lift it; a reconnection to Gladys (which goes through
  `configUpdated`) never does (review M1).
- **Refused credentials**: stop with a new try after 1 h, 6 h, then every
  24 h; at once on a credentials change or the test button. Same schedule for
  `session_refused` and a new password asked.
- **New credentials drop the old tokens** (review M2): `start({ fresh })`
  clears the tokens too, so another password signs in again.
- **No English in the French statuses** (review M3): the reasons are
  translated by error kind (`reasonOf`), with the HTTP status only; the
  English `errorReason` stays for the logs.
- **Tokens in /data** (as gladys-schlage): 0600, a hash of the user name,
  never the user name nor the password; another user name drops the tokens
  and the stops (a 429 pause stays). The refresh token gives control of the
  stoves: said in the docs.
- **Gzip Buffer fields** (edilkamin.py buffer_utils): inflated with
  `maxOutputLength` 1 MB, bytes checked, depth 8; a field that fails is kept
  as it came (its values then read as unknown).
- **Units**: `celsius` on the temperature (temperature-sensor) and the
  setpoint (thermostat), the only ones the core lists
  (DEVICE_FEATURE_UNITS_BY_CATEGORY); fans have no unit (a level, not a
  percent).
- **Pellet level**: only `is_pellet_in_reserve` (binary). The autonomy
  (`status.pellet.autonomy_time`) is not published: its unit is unknown and a
  unit is frozen at creation.
- **Alarms and errors**: `nvm.alarms_log` is not in edilkamin.py; read when
  present (count, newest code and time), shown as a text in UTC (no time
  zone guess), and the scene trigger on a growing count. `status.commands.
alarm_reset` is not used (its meaning is unclear).
- **Interval 60 s (60–900)**: one request per stove; errors are never read
  again faster than it.
- **429**: Retry-After between 60 s and 6 h (5 min when absent), for every
  path but turning off, persisted and capped at 6 h when read back; a
  reconnection to Gladys keeps it.
- **Status and Discovery at each `connected`**: the deduplication caches
  (last status, last Discovery list, badges) are cleared and sent again; the
  tokens, pauses and stops stay.
- **Logs**: never a password, token, user name or whole MAC (its last 4
  characters only); `errorReason` never prints an unknown error's message.
- **Legacy API not used** (edilkamin.py deprecates it).
- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag: the one-time exception to "versions
  belong to the Release workflow" (the template's 1.0.0 had to be replaced);
  the first patch release gives 0.1.1.
- **LICENSE**: the standard Apache-2.0 text (appendix placeholder, no
  personal name); `THIRD_PARTY_NOTICES.md` credits edilkamin.py (MIT, full
  notice) and pycognito (Apache-2.0); both copied into the image.
- **The app's Cognito pool and client id** are in `src/constants.js`, as in
  edilkamin.py: public constants of The Mind app, not secrets of the user.
