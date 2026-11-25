// Static self-reference fixture for the SDK's own package metadata. This
// consumes "labkit" and "labkit/testing" by package name inside the SDK tree;
// it is deliberately not an independent consumer project or copied install.
import {
  CONTRACT_VERSION,
  PcmGraph,
  PcmPlayer,
  attachMidi,
  createLab,
  createPcmBuffer,
  drawGrid,
  linearScale,
  midiNoteVelocity,
  renderError,
  sampleSeries,
  type AttachedMidi,
  type LabDefinition,
  type LabInstance,
  type LabServices,
  type PcmScheduler,
  type WorkletContextState,
  type WorkletErrorInfo,
} from "labkit";
import {
  FakeAudioEnvironment,
  FakeMidiEnvironment,
  FakeScheduler,
  FakeWorkletEnvironment,
} from "labkit/testing";

// @ts-expect-error production root must not export test doubles
import { FakeScheduler as RootFakeScheduler } from "labkit";

// @ts-expect-error deep source paths are not public package exports
import { WorkletSession as DeepWorkletSession } from "labkit/src/audio/worklet";

const scheduler: PcmScheduler = {
  schedule: () => 1,
  cancel: () => {},
};

interface DemoState {
  value: number;
}

const demoDefinition: LabDefinition<DemoState> = {
  contractVersion: CONTRACT_VERSION,
  id: "typecheck-demo",
  title: "Typecheck demo",
  model: { createState: () => ({ value: 0 }) },
  parameters: {
    value: {
      kind: "number",
      id: "value",
      label: "Value",
      min: 0,
      max: 1,
      step: "any",
      read: (state) => state.value,
      write: (state, value) => {
        state.value = value;
      },
    },
  },
  readouts: { value: (state) => `value=${state.value}` },
  layout: {
    controls: [{ kind: "control", param: "value" }],
    workspace: [{ kind: "readout", id: "value", variant: "stat" }],
  },
};

declare const host: HTMLElement;
declare const services: LabServices;
const instance: LabInstance<DemoState> = createLab(demoDefinition, host, services);
const stateValue: number = instance.state.value;
void stateValue;

declare const attachedMidi: AttachedMidi;
const attachedAdapter: AttachedMidi["midi"] = attachedMidi.midi;
void attachedAdapter;

const workletContextState: WorkletContextState = "suspended";
const workletErrorInfo: WorkletErrorInfo = { current: true };
void workletContextState;
void workletErrorInfo;

const api = {
  attachMidi,
  createPcmBuffer,
  drawGrid,
  linearScale,
  midiNoteVelocity,
  pcmGraph: PcmGraph,
  pcmPlayer: PcmPlayer,
  renderError,
  sampleSeries,
  scheduler,
  testing: [FakeAudioEnvironment, FakeMidiEnvironment, FakeScheduler, FakeWorkletEnvironment],
} satisfies Record<string, unknown>;

void api;
void RootFakeScheduler;
void DeepWorkletSession;
