# gladys-edilkamin

[Gladys Assistant](https://gladysassistant.com) external integration for
**Edilkamin "The Mind"** pellet stoves, through the Edilkamin cloud (the
unofficial API of The Mind app): on/off state, room temperature, setpoint,
power level, fans, pellet reserve, last alarm, and a scene trigger on a new
alarm. Turning a stove off is always allowed; lighting it, and changing its
setpoint or power level, stay off until the user allows them. Unofficial, not
affiliated with Edilkamin.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Work in progress (milestone 1).** Unofficial API, tested against a fake
> Edilkamin cloud only, never with a real stove or account.

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (EdilkaminApp) ⇄ src/client.js ⇄ the-mind-api.edilkamin.com
                                   │                             └─ src/cognito.js + src/srp.js ⇄ cognito-idp.eu-central-1
                                   ├─ src/edilkamin.js  stove documents, gzip Buffers (pure)
                                   ├─ src/devices.js    -> Gladys devices and states (pure)
                                   ├─ src/store.js      /data: tokens, pauses, stops
                                   └─ src/publisher.js  300 states and scene events/min
```

- **Sign-in** (as edilkamin.py with pycognito): AWS Cognito `USER_SRP_AUTH`
  on the user pool of The Mind app (a public client: no `SECRET_HASH`), then
  `PASSWORD_VERIFIER` (SRP-6a, 3072-bit group, "Caldera Derived Key";
  checked against pycognito in `test/srp.test.js`). The bearer of the API is
  the **id token**. It is renewed 5 minutes before it expires with
  `REFRESH_TOKEN_AUTH`, by a timer of its own whatever the poll interval; a
  refused refresh token is dropped and the password signs in once. A code
  challenge (`SMS_MFA`, `EMAIL_OTP`, `SOFTWARE_TOKEN_MFA`) or any other
  challenge but `NEW_PASSWORD_REQUIRED` is not handled: a stop without a new
  try by itself (the test button, or new credentials, lift it). A 429 of the
  Edilkamin API never stops the renewals; one of Cognito does. Tokens are kept in
  `/data/edilkamin-state.json` (0600) with a hash of the user name, never the
  user name nor the password.
- **Reading**: the cloud has no list of the stoves of an account, so the MAC
  addresses are typed in the configuration (10 at most). `GET
device/{mac}/info` for each stove every 60 s (60 to 900), plus 5, 15 and 45 s
  after a command; its gzip Buffer fields are inflated (bounded to 1 MB). A
  404, a 403, a 5xx, a timeout or a bad document marks that stove only
  (degraded badge); a 403 on every stove pauses 30 min, and the cycle is
  "unreachable" only when no stove answered. A 401 renews the token once and retries once
  (again: `session_refused`, spaced new tries). Refused credentials: stop, new
  try after 1 h, 6 h, then every 24 h. 429: a pause of Retry-After between
  60 s and 6 h for every path but turning off; pauses and stops are kept in
  `/data` and capped when read back. Network errors: 1, 2, 5, 10, 15 min,
  never under the interval.
- **Devices**: `ext:<selector>:edilkamin:<mac>`. Features by role: `power`
  (unknown/binary, read only), `power-on` and `power-off` (button/push),
  `temperature` (temperature-sensor, °C), `setpoint`
  (thermostat/target-temperature, °C, writable), `power-level` (text/select
  P1 to P5, writable), `fan-1` to `fan-3` (fan/speed, read only),
  `pellet-reserve` (unknown/binary), `last-alarm` (text, when the document
  has `nvm.alarms_log`). A republished device keeps the features it was
  created with. No switch: an "everything on" or "everything off" never reaches a stove.
- **Commands** (`PUT mqtt/command` `{ mac_address, name, value }`): every one
  is refused when it cannot be sent within 3.5 s of its arrival (sent by
  3.4 s, answered by 4.6 s). Lighting needs `allow_power_on`, a token valid
  60 s more, a fresh read that says the stove is off, no guard; the setpoint
  and the power level need `allow_commands` and a fresh read that has the
  current value; these three run one at a time per stove. Turning off is
  always allowed and always sends `power` 0 (no read, no "already off"): it
  never waits behind the chain, only behind a lighting PUT already in flight
  (until its own deadline), is sent during a 429/403 pause or a stop, renews
  an expired token within its deadline, and on a 401 renews and sends once
  more. A turn off is counted at its arrival: a lighting that sees the count
  change (before its read, after it, right before its PUT) is refused. After
  a power command, a guard refuses lighting until a read at least 4 s later
  shows the expected state, 60 s at most.
- **Scene trigger**: `stove_alarm` (`stove`, `code`) when the alarm count of
  `nvm.alarms_log` grows between two reads at most two intervals apart; never
  on the first read.

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit
npx github:GladysAssistant/integration-store .  # store admission checks
```

`test/fixtures/edilkamin.js` holds stove documents shaped like those
edilkamin.py reads (made-up values, some fields as gzip Buffers);
`test/helpers/fakeEdilkamin.js` is a fake Cognito (it runs the server half of
SRP and checks the proof) and a fake Edilkamin API behind the transport.

## Credits

- [AndreMiras/edilkamin.py](https://github.com/AndreMiras/edilkamin.py) (MIT):
  the API, the Cognito pool and client, the stove document and the commands
  are ported to JavaScript.
- [pvizeli/pycognito](https://github.com/pvizeli/pycognito) (Apache-2.0): the
  SRP computation.
- Notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release. The
`gladys-assistant-integration` topic lists the repository in the Gladys store
(added at the first real release).

## License

Apache-2.0 (see [LICENSE](LICENSE)); the ported logic is MIT (edilkamin.py)
and Apache-2.0 (pycognito), see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Edilkamin and The Mind are trademarks of Edilkamin; this project is not
affiliated with Edilkamin.
