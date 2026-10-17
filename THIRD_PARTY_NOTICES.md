# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the projects below. The ported parts were
rewritten in JavaScript; they are changed from the originals (another
language, another structure, only what this integration needs). None of the
original code is copied as is.

## edilkamin.py

- Project: [AndreMiras/edilkamin.py](https://github.com/AndreMiras/edilkamin.py),
  version 1.7.0, the Python library for the Edilkamin "The Mind" API, by
  Andre Miras.
- What is ported (in `src/constants.js`, `src/cognito.js`, `src/client.js`
  and `src/edilkamin.js`): the AWS Cognito user pool and app client of the
  The Mind app, the base URL of the API, the sign-in (SRP through pycognito,
  the id token as the bearer), the stove document (`GET device/{mac}/info`)
  and the inflating of its gzip Buffer fields, the paths of the values read
  (power, room temperature, setpoint, manual power level, fans, pellet
  reserve), the command endpoint (`PUT mqtt/command`) and the names of the
  commands used (`power`, `enviroment_1_temperature`, `power_level`), and the
  format of the MAC addresses.
- Licence: MIT. Its full notice:

```text
MIT License

Copyright (c) 2022 Andre Miras

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

## pycognito

- Project: [pvizeli/pycognito](https://github.com/pvizeli/pycognito), by
  Pascal Vizeli (the Cognito client edilkamin.py uses), itself following
  [amazon-cognito-identity-js](https://github.com/amazon-archives/amazon-cognito-identity-js).
- What is ported (in `src/srp.js` and `src/cognito.js`): the SRP computation
  of `aws_srp.py` (the 3072-bit group, `k`, `pad_hex`, the "Caldera Derived
  Key" HKDF, the timestamp format, the PASSWORD_VERIFIER claim) and the
  refresh token flow. `test/srp.test.js` checks the result against values
  computed by pycognito 2024.5.1.
- Licence: Apache License 2.0, whose full text is the `LICENSE` file shipped
  with this integration (and copied into its Docker image). pycognito ships
  no `NOTICE` file.
