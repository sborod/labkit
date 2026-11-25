export { ParameterRegistry } from "./core/registry.ts";
export { ActionRegistry } from "./core/actions.ts";
export type { ActionSpec } from "./core/actions.ts";
export type { ActionContext, RuntimeContext, TimelineControl } from "./core/context.ts";
export type { Origin } from "./core/origin.ts";
export type { BatchChange, ParamChange } from "./core/events.ts";
export type {
  BooleanParamSpec,
  EnumOption,
  EnumParamSpec,
  NumberParamSpec,
  ParameterSpec,
  ParamKind,
} from "./core/params.ts";

export { createLab } from "./runtime/createLab.ts";
export type { LabInstance, LabServices } from "./runtime/createLab.ts";
export type { LabErrorEvent, LabErrorPhase, Lifetime } from "./runtime/lifetime.ts";
export { CONTRACT_VERSION } from "./runtime/definition.ts";
export type {
  ContractVersion,
  LabCapabilities,
  LabDefinition,
  RuntimeHooks,
  ViewContext,
  ViewSpec,
} from "./runtime/definition.ts";
export {
  LabDefinitionError,
  validateDefinitionStructure,
  validateInitialState,
} from "./runtime/validation.ts";
export {
  CapabilityError,
  browserCapabilityEnvironment,
  checkCapabilities,
  detectCapabilities,
  formatCapabilityStatuses,
} from "./runtime/capabilities.ts";
export type {
  CapabilityEnvironment,
  CapabilityId,
  CapabilityInfo,
  CapabilityReport,
  CapabilityStatus,
} from "./runtime/capabilities.ts";
export { Scope } from "./runtime/scope.ts";
export type { Disposer } from "./runtime/scope.ts";
export { Timeline } from "./runtime/timeline.ts";
export type { FrameScheduler, FrameCanceller } from "./runtime/timeline.ts";
export { DisplaySurface } from "./runtime/surface.ts";
export type { SurfacePolicy } from "./runtime/surface.ts";

export { createControl } from "./ui/controls.ts";
export type { ControlHandle } from "./ui/controls.ts";
export { createInlineError } from "./ui/inline-error.ts";
export type { InlineErrorHandle } from "./ui/inline-error.ts";
export { renderError } from "./ui/status.ts";
export type { LabLayout, LayoutNode, ReadoutVariant } from "./ui/layout.ts";
export { THEME_ATTRIBUTE } from "./ui/theme.ts";

// PCM
export { PcmGraph, PcmPlayer, createPcmBuffer } from "./audio/pcm.ts";
export type {
  PcmAudioContext,
  PcmEnvironment,
  PcmPlayerOptions,
  PcmScheduler,
  PcmSource,
  PcmStatus,
} from "./audio/pcm.ts";
export { realPcmEnvironment } from "./audio/environment.ts";

// AudioWorklet
export { WorkletSession } from "./audio/worklet.ts";
export type {
  WorkletAnalyser,
  WorkletAudioContext,
  WorkletContextState,
  WorkletEnvironment,
  WorkletErrorInfo,
  WorkletGain,
  WorkletNodeLike,
  WorkletNodeOptions,
  WorkletPort,
  WorkletSessionOptions,
  WorkletStatus,
  WorkletTelemetry,
} from "./audio/worklet.ts";
export { realWorkletEnvironment } from "./audio/worklet-environment.ts";

// MIDI
export { MidiAdapter } from "./midi/adapter.ts";
export type {
  MidiActionHost,
  MidiAdapterOptions,
  MidiParamHost,
  MidiTargetInfo,
} from "./midi/adapter.ts";
export { midiNoteVelocity } from "./midi/action-input.ts";
export { attachMidi } from "./midi/attach.ts";
export type { AttachedMidi } from "./midi/attach.ts";
export { createMidiPanel } from "./midi/panel.ts";
export type { MidiPanelHandle, MidiPanelOptions } from "./midi/panel.ts";
export {
  absoluteScale,
  decodeMidiMessage,
  isRelative,
  quantize,
  relativeDelta,
  switchFromValue,
} from "./midi/decode.ts";
export {
  MemoryMidiStorage,
  MIDI_STORAGE_VERSION,
  loadMidiState,
  midiStorageKey,
  saveMidiState,
} from "./midi/store.ts";
export type { MidiStorage, StoredMidiState } from "./midi/store.ts";
export { realMidiEnvironment } from "./midi/environment.ts";
export type {
  MidiAccessLike,
  MidiActionInput,
  MidiDeviceInfo,
  MidiEnvironment,
  MidiInputEvent,
  MidiInputLike,
  MidiMapping,
  MidiMessage,
  MidiMode,
  MidiOutputLike,
  MidiSource,
  MidiStatus,
  MidiStatusKind,
} from "./midi/types.ts";

export {
  drawGrid,
  drawPolyline,
  drawXTickLabels,
  drawZeroAxes,
  linearScale,
  sampleSeries,
} from "./plot/index.ts";
export type { LinearScale, PlotStyle, Point, Rect, Vec2 } from "./plot/index.ts";
