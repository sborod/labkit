# Lab Template

A standalone starting point for a browser lab using LabKit. It includes a knob,
a readout, a reset action, optional MIDI-learn and tests. Audio is not started
or required. The dependency is pinned to the initial public LabKit commit.

## Start

Copy this directory (including dotfiles) outside the SDK repository, for example
from its root:

```sh
cp -R templates/lab-template ../my-lab
cd ../my-lab
npm ci
npm run dev
```

Requires Node.js 24.15.0 and Git. The public `sborod/labkit` repository requires no credentials. The SDK builds automatically during npm installation.
No sibling SDK directory is needed. To use MIDI, open the Vite localhost page
in a browser with Web MIDI support and connect through the SDK's MIDI panel.

Before making the lab your own:

- Change the package name in package.json and run `npm install --package-lock-only`
  to synchronize the lockfile.
- Set unique `LAB_ID` and `LAB_TITLE` in definition.ts; update the HTML title.
  The id also namespaces MIDI mappings, so don't reuse it across labs.
- Replace the model in state.ts and the example parameters, actions and layout
  in definition.ts. Remove MIDI setup if the lab does not need it.
- Update this README and the tests. Initialize your own Git repository if desired.

## Commands

```sh
npm run dev         # localhost development
npm run typecheck
npm test           # Vitest
npm run build      # dist/index.html plus bundled assets
npm run preview    # serve the production build
npm run verify     # typecheck + tests + build
```

Serve the built dist directory over HTTP(S); opening index.html directly as a
file is not a supported deployment path. Web MIDI and AudioWorklet require a
secure context (localhost or HTTPS).

## Structure

- state.ts: canonical model and fresh state factory.
- definition.ts: SDK parameter bindings, actions, readouts, layout and hooks.
- mount.ts: shared production/test mount seam.
- production.ts: HTML bootstrap, stylesheet, error handling and HMR cleanup.
- tests/unit: model and mounted-instance tests with a fake MIDI environment.

Keep mathematical models, DSP and instrument-specific behavior in the lab.
Use the public SDK API for controls, resource lifetime, canvas, audio and MIDI.
For audio, add PCM or AudioWorklet only when needed and start audio on an
explicit user gesture.

See the [SDK contract](https://github.com/sborod/labkit/blob/main/docs/CONTRACT.md)
and [release guide](https://github.com/sborod/labkit/blob/main/docs/RELEASING.md)
for version updates, public installation and local SDK development.
