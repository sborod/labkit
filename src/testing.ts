// Явная тестовая точка входа SDK. Fake-адаптеры не входят в production exports.
export { FakeWorkletEnvironment } from "./audio/worklet-testing.ts";
export type { FakeWorkletNode } from "./audio/worklet-testing.ts";
export { FakeMidiEnvironment } from "./midi/testing.ts";
export { FakeAudioEnvironment, FakeScheduler } from "./audio/testing.ts";
