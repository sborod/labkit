# Development and verification

## Requirements

Use Node.js 24.15.0 (the version in package.json), npm and Git. Run from the SDK root:

```sh
npm ci
npx playwright install chromium
```

The prepare hook builds the SDK on install. Rebuild after edits with
`npm run build`. On Linux CI, Playwright also installs Chromium system dependencies.

## Repository map

| Directory              | Responsibility                                                     |
| ---------------------- | ------------------------------------------------------------------ |
| src/core               | Parameter/action registries, origins and events                    |
| src/runtime            | Definition validation, mount, rendering, capabilities and lifetime |
| src/ui                 | Controls, layout, theme and accessibility                          |
| src/plot               | Canvas plotting primitives                                         |
| src/audio              | PCM and AudioWorklet adapters                                      |
| src/midi               | MIDI access, mappings, persistence and UI                          |
| tests                  | SDK unit, browser, fixture and package tests                       |
| templates/lab-template | Standalone lab starter; not part of the npm artifact               |
| scripts                | Package and template consumer checks                               |

Keep source independent of consumer laboratories. Public entry points are
defined in package.json and src/index.ts / src/testing.ts; do not export
implementation details just to make a test easier.

## Commands

| Command                | Purpose                                              |
| ---------------------- | ---------------------------------------------------- |
| `npm run format`       | Apply Prettier                                       |
| `npm run format:check` | Check formatting without writing                     |
| `npm run lint`         | ESLint with TypeScript support; no warnings allowed  |
| `npm run lint:fix`     | Apply ESLint autofixes                               |
| `npm run typecheck`    | Strict TypeScript checks for source, tests and tools |
| `npm run build`        | Build ESM, CSS and declarations                      |
| `npm run test:unit`    | Vitest unit and jsdom tests                          |
| `npm run test:browser` | Playwright Chromium fixtures                         |
| `npm run test:package` | Build and check package exports and artifacts        |
| `npm test`             | Unit, browser and package tests                      |
| `npm run verify`       | Format check, lint, typecheck and all SDK tests      |

To reproduce CI consumer checks after building:

```sh
npm pack --ignore-scripts
npm run test:consumer -- "$PWD/labkit-0.1.1.tgz"
node scripts/test-template.mjs "$PWD/labkit-0.1.1.tgz"
```

Use the actual package version in the archive name. The template smoke test
copies the template into a temporary directory and substitutes the candidate
archive; its checked-in release URL and lockfile integrity are validated separately.
The Git smoke test uses a local Git URL pointing at a committed revision, not
uncommitted changes.

## Quality policy

Prettier owns formatting for TypeScript, JavaScript, CSS, JSON, HTML, Markdown
and YAML. ESLint owns code-quality checks; TypeScript owns typechecking.
Use the repository configuration rather than editor-specific defaults.
Generated output and lockfiles are excluded from formatting. Do not use broad
lint suppressions to hide new issues; explain deliberate exceptions locally.

Document runtime guarantees in CONTRACT.md, integration and subsystem behavior
in the relevant guide, and user-visible changes in CHANGELOG.md. Source comments
should explain invariants, lifecycle ordering, non-obvious decisions and reasons
for constraints, not narrate implementation history or restate code.

## CI and scope

PRs and main builds check formatting, lint, types, unit/browser/package tests,
then install the packed SDK and Git source in independent consumers and build
the standalone template. The release job publishes only a verified new version.
See [release policy](RELEASING.md).

Browser automation covers Chromium, not physical MIDI devices, every browser
or real audio hardware. Run lab-specific integration and hardware checks in the
consumer repositories when changing behavior that requires them.
