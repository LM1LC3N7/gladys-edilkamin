# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Edilkamin "The Mind" pellet stoves, through the Edilkamin cloud (unofficial
  API, ported from edilkamin.py), from their MAC addresses (10 at most).
- Sign-in with the user name and the password through AWS Cognito SRP (the
  password itself is never sent); the token is renewed from the refresh
  token by a timer, without a new sign-in at each read; the tokens are kept
  in `/data` so a restart does not sign in again.
- On/off state (read only), room temperature, setpoint, power level (P1 to
  P5), fans, pellet reserve, last alarm (when the stove document has an alarm
  log).
- "Light the stove" and "Turn the stove off" buttons: turning off is always
  allowed and never waits; lighting is off by default (`allow_power_on`). No
  switch, so an "everything on" never lights a stove.
- Setpoint (12 to 30 °C, half degrees) and power level from Gladys, off by
  default (`allow_commands`).
- Every command reads the stove again just before acting and is refused when
  it cannot be sent within 3.5 s of its arrival; lighting, the setpoint and
  the power level are refused when that read fails or lacks the value, and run
  one at a time per stove; a guard after a power command (60 s at most).
- Scene trigger "Edilkamin stove alarm" (stove name, alarm code).
- The stoves are read every 60 s (60 to 900); refused credentials stop the
  integration with a new try after 1 h, 6 h, then every 24 h; a verification
  code asked stops it for good until the user acts; a 429 pauses every path
  but turning off for 60 s to 6 h, kept across restarts; a 403 on every stove
  pauses 30 minutes; one unreadable stove only gets a degraded badge.
- "Test the connection" button; the status and the Discovery list are sent
  again at each reconnection to Gladys.
- Feature names and texts in French or English.

[Unreleased]: https://github.com/LM1LC3N7/gladys-edilkamin/commits/main
