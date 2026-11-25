# LabKit SDK

LabKit is a TypeScript SDK for standalone interactive browser laboratories and
instruments. It supplies a per-instance runtime, declarative controls and layout,
canvas plotting, PCM and AudioWorklet audio, and Web MIDI. Mathematical models,
DSP, musical transport and file formats belong to individual labs.

LabKit is publicly available on GitHub and ESM-only. Releases are distributed through
[GitHub Releases](https://github.com/sborod/labkit/releases), not the npm registry.

## Create a laboratory

Copy the [starter template](templates/lab-template/) from the SDK repository:

```sh
cp -R templates/lab-template ../my-lab
cd ../my-lab
npm ci
npm run dev
```

Requires Node.js 24.15.0 and Git. The template includes a
knob, readout, reset action, optional MIDI-learn, tests, and agent instructions.
Follow the [template guide](templates/lab-template/README.md) to rename it.

## Add LabKit to an existing project

```sh
npm install --save-exact 'git+https://github.com/sborod/labkit.git#v0.1.1'
```

Commit both npm manifests. The Git installation builds the SDK automatically;
the alternative release archive is already built. See
[installation and releases](docs/RELEASING.md) for installation and updates.

## Public API

| Import              | Purpose                                                       |
| ------------------- | ------------------------------------------------------------- |
| `labkit`            | Runtime, registries, UI, plotting, PCM, AudioWorklet and MIDI |
| `labkit/testing`    | Fake audio, scheduler, worklet and MIDI environments          |
| `labkit/labkit.css` | SDK stylesheet (explicit import)                              |

Use only these entry points. Internal source paths are not public. The package
contains built ESM (ES2022), CSS and TypeScript declarations.

The [minimal definition](templates/lab-template/definition.ts) and
[production entry](templates/lab-template/production.ts) show how to create,
mount and dispose a lab using the public API.

## Documentation

- [Runtime contract](docs/CONTRACT.md): state, actions, layout, rendering,
  capabilities, errors and lifetime.
- [Development and verification](docs/DEVELOPMENT.md): repository structure,
  lint, formatting, tests and CI.
- [Installation and releases](docs/RELEASING.md): version policy, public Git,
  archives and local SDK development.
- [Audio](src/audio/README.md): PCM and AudioWorklet integration.
- [MIDI](src/midi/README.md): mapping, event streams, persistence and UI.
- [Package tests](tests/package/README.md): exported artifact and consumer checks.
- [Changelog](CHANGELOG.md): released and unreleased changes.

## Develop the SDK

```sh
npm ci
npx playwright install chromium
npm run verify
```

`npm run format` applies Prettier. `npm run lint:fix` applies ESLint fixes.
CI checks both without modifying source files.
