# Instructions for this laboratory

- Read README.md and the LabKit public contract before changing the integration.
- Use only the public exports: `labkit`, `labkit/testing` (tests only), and
  `labkit/labkit.css`. Do not deep-import SDK source or duplicate its runtime,
  controls, MIDI stack, audio infrastructure or plotting helpers.
- Keep one canonical per-instance model. Route controlled changes through the
  SDK parameter registry; commands belong in the action registry. Explicitly
  request rendering after direct model changes.
- Preserve stable parameter/action ids and the unique lab/MIDI namespace.
  Keep model, DSP, transport and persistence formats specific to this lab.
- Use the same mount function for production and tests. Inject fake environments
  rather than replacing production logic. Register cleanup through lifetime;
  release resources on dispose. Never request audio or MIDI access automatically
  on mount; audio starts from a user gesture.
- Declare required/optional capabilities honestly. Do not silently introduce
  fallback audio engines or duplicate MIDI adapters.
- Keep the SDK version pinned and commit package.json with package-lock.json.
  Never commit credentials, machine-local paths or generated dist/node_modules.
- Run `npm run verify` before committing. Add tests for changed behavior.
  Document any browser, hardware or manual checks you could not perform.
- Prefer small explicit modules, short invariant/decision comments, and current
  documentation. Avoid speculative abstractions and comments narrating edits.
