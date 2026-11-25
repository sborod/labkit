// Public API and export-boundary checks for the packaged SDK. Everything is
// imported locally by package self-reference; no external consumer is built.
import assert from "node:assert/strict";
import { test } from "node:test";

const TESTING_EXPORTS = [
  "FakeAudioEnvironment",
  "FakeMidiEnvironment",
  "FakeScheduler",
  "FakeWorkletEnvironment",
];

const PRESERVED_ROOT_API = [
  // PCM
  "PcmGraph",
  "PcmPlayer",
  "createPcmBuffer",
  // Plot
  "drawGrid",
  "drawPolyline",
  "drawXTickLabels",
  "drawZeroAxes",
  "linearScale",
  "sampleSeries",
  // MIDI, status and error paths
  "attachMidi",
  "midiNoteVelocity",
  "renderError",
];

test("root keeps its API, hides test doubles and rejects non-exported subpaths", async () => {
  const root = await import("labkit");
  const testing = await import("labkit/testing");

  for (const name of PRESERVED_ROOT_API) {
    assert.equal(typeof root[name], "function", `root export ${name} is missing`);
  }

  assert.deepEqual(
    Object.keys(root).filter((name) => name.startsWith("Fake")),
    [],
    "production root must not expose Fake* exports",
  );
  for (const name of TESTING_EXPORTS) {
    assert.equal(root[name], undefined, `root must not expose ${name}`);
  }

  assert.deepEqual(Object.keys(testing).sort(), TESTING_EXPORTS);
  for (const name of TESTING_EXPORTS) {
    assert.equal(typeof testing[name], "function", `testing export ${name} is missing`);
  }

  const rejected = ["labkit/src/index.ts", "labkit/audio/worklet", "labkit/dist/labkit.js"];

  for (const specifier of rejected) {
    await assert.rejects(
      import(specifier),
      (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
      `${specifier} must not resolve outside package exports`,
    );
  }
});
