# qq-bridge protocol reference

DSH Web API protocol and event handling were studied from https://github.com/Derpyu520/qq-bridge at a56164e70a0521a7829138a42eee76066fde2b8b. The standalone implementation is kept separate; attribution for any adapted protocol handling follows.

MIT License

Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors

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

The ws dependency carries its own MIT license under node_modules/ws/LICENSE.

# dsh-plugin-memory reusable modules

The nine source modules listed in `lib/legacy-memory/provenance.json`, the original memory skill, and the CLI (import paths adapted) are reused from the migrated `dsh-plugin-memory` 0.10.0-qq.6 project. They depend only on Node builtins and do not load the DSH plugin runtime. Copyright (c) 2026 dsh-plugin-memory contributors. The full MIT notice is retained in `lib/legacy-memory/LICENSE`.

The explicitly enabled local DSH browser-session authentication follows the protocol described by qq-bridge src/dsh-client.js (same commit above). js-yaml retains its MIT license under node_modules/js-yaml/LICENSE. NapCat is a separately downloaded official runtime, not vendored into the standalone source package.

# Migrated QQ policies

Version 0.4 imports the original `dsh-plugin-memory-source/lib/recall-policy.js` and `recall-nudge.js`, `dsh-group-social/lib/{images,security,core}.mjs`, and `dsh-companion-voice/lib/core.mjs`. These are the preserved source modules in this repository, not reimplementations labelled as originals. Their own license notices and module attribution remain in the source directories. The DSH/Cordis plugin entry points are not started by these imports.
