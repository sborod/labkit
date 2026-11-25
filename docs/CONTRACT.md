# LabKit SDK contract

This document specifies runtime contract `0.1`. The contract version is distinct
from the npm package version; see [release policy](RELEASING.md). Public type
declarations describe the API; this document specifies its behavior.

Public package entry points are `labkit`, `labkit/testing` and
`labkit/labkit.css`. Test doubles are exported only from `labkit/testing`.

## Definition and instance

`LabDefinition<S>` is declarative. `createLab(definition, mountEl, services?)`
creates one `LabInstance<S>` synchronously. Validation of the definition and its
initial state happens before instance resources are created. `contractVersion`
must equal `CONTRACT_VERSION`; a mismatch is a `LabDefinitionError`, not an
attempt to guess an older format.

Every instance owns its canonical `state` from `model.createState()`, its
parameter and action registries, its timeline, its root DOM, its surfaces and
its lifetime. There are no shared mutable runtime singletons.

## Canonical state and registries

- The only copy of a parameter value is the instance state. A parameter spec
  supplies `read`/`write` bindings to that state; the registry does not keep a
  second value.
- The model may write its own fields directly. Such writes bypass the registry:
  they do not produce `ParamChange`/`BatchChange` events and do not call
  `hooks.onChange`.
- Controlled writes go through `params.set(id, value, origin)`. Types are
  strict; numbers are clamped to `min`/`max`; enums must match an offered
  value; booleans must be booleans. `available` is checked on the same path for
  every origin (`ui`, `midi`, `preset`, `api`, `timeline`). An event is emitted
  only when the stored value actually changed.
- `params.transaction(origin, fn)` emits one batch for the grouped writes. It is
  batching, not rollback: changes already applied are delivered, and errors
  propagate.
- An action is a command without a stored value. Each
  `actions.execute(id, origin, input?)` invocation gets its own
  `ActionContext` with that `origin` and an opaque `input`. Core passes the
  payload as-is, without cloning, freezing or retaining it between calls.
  Executing an unavailable action is an explicit error. Overlapping async
  invocations do not share action payloads.

## Capabilities

`capabilities.required` and `capabilities.optional` are explicit lists of known
capability ids: `canvas`, `audioContext`, `audioWorklet`, `worker`, `midi`.

- A missing required capability aborts mounting with `CapabilityError`. There is
  no silent fallback.
- A missing optional capability disables only that capability and is reported
  in the instance UI as a status; the rest of the instance continues.
- Capability detection does not create an `AudioContext`. `audioWorklet` and
  `midi` additionally require a secure context.

Unknown capability ids are a `LabDefinitionError`.

## Layout, visibility and accessibility

`layout.controls` and `layout.workspace` contain `LayoutNode` values: `group`,
`row`, `control`, `action`, `panel`, `readout`, `note` and `window`. `header`
and `toolbar` are optional explicit regions. The runtime builds the DOM;
controls and MIDI address the registries by id, not the DOM, and synthetic DOM
events are not used as a bridge.

- `visible` controls whether a control is shown. Hiding a control also hides its
  `className` wrapper when the wrapper is the control's layout cell.
- `available` disables interaction with a control or action but does not remove
  it. Availability is re-read from canonical state on rendering.
- Each control keeps an accessible name from its parameter/action label.
  `displayLabel` changes visible text, not the accessible name or registry id.
  Segmented enum controls expose `aria-pressed`; boolean pads retain a native
  checkbox; number knobs expose slider semantics and ARIA values.
- Information windows and the MIDI settings window are non-modal dialogs
  (`aria-modal="false"`), close on their button or Escape, and return focus to
  the opener only when focus is still inside the closed surface.
- An unknown view or readout id is an explicit mounting error.

## Rendering and surfaces

- `ctx.requestRender()` requests a redraw and coalesces pending requests.
  `instance.render()` performs a synchronous redraw.
- After a successful `hooks.animation.step`, the runtime requests a redraw
  itself. Model changes made outside that step are shown after an explicit
  `ctx.requestRender()` or `instance.render()`.
- On every render the runtime synchronizes views, readouts, action labels and
  availability, and controls with canonical state, including state changed
  without a registry event. Mirrored writes and synthetic DOM events are not
  used. An error in one control does not prevent the others from updating.
- Three scales are independent: the CSS size of the panel, the canvas bitmap
  (`CSS size × devicePixelRatio`, capped at DPR 2 for layout panels), and the
  computational grid owned by the view/model. Views receive logical CSS
  `width`/`height` and draw in CSS coordinates; the canvas context is already
  scaled for the bitmap.
- A CSS resize or DPR change invalidates and redraws the surface, including
  while the timeline is paused. It does not change the computational grid.

## Setup and lifetime

`hooks.setup(ctx, lifetime)` runs synchronously before the first render and
initializes per-instance resources.

- Its return type is `undefined`. An async/thenable result is rejected by the
  runtime and fails mounting rather than being awaited.
- `lifetime.add(disposer)` registers cleanup in the instance scope.
- `lifetime.disposed` is a live getter, not a copied boolean.
- `lifetime.reportError(phase, error)` sends the error to the instance error
  channel.
- An error during setup is a mounting error; resources created so far, including
  those added through `lifetime.add`, are released.

## Errors

`LabDefinitionError` and `CapabilityError` reject loading before an instance is
created. Runtime errors are caught by phase and reported through a visible
`.labkit-status--error[role="alert"]` banner and through
`services.onError({ lab, phase, error })`.

Phases are `render`, `hook`, `animation`, `action`, `control`, `cleanup` and
`setup`. An animation-step error stops the timeline. The first render is
synchronous; its error is a mounting error and releases resources. Late errors
after disposal are diagnostic logging only and do not touch the detached UI.

`createInlineError(document)` provides a small local error element with
`role="alert"`; `set(message)` writes only via `textContent`, and `null` or an
empty string clears it. The owner places and removes the element.

## Disposal

`instance.dispose()` is idempotent and awaitable. Repeated calls, including a
reentrant call from a disposer, return the same promise. It releases
subscriptions, timeline, surfaces and DOM, together with resources registered
through `lifetime.add`.

Every disposer runs even when another disposer throws. If any cleanup fails, the
disposal promise rejects with `AggregateError`; success is not simulated. After
disposal, deferred render/hooks/action work does not run, the timeline is
terminal, and adding new resources to the lifetime is an explicit error.

## PCM and AudioWorklet

PCM and realtime DSP are separate execution models, not fallbacks for each
other.

PCM uses `PcmGraph` and `PcmPlayer`:

- the consumer supplies `PcmSource.key()` and `PcmSource.render(sampleRate)`;
  volume is not part of the physics key;
- a new hit sets a new anchor, while replacing a buffer keeps the previous
  anchor; elapsed time is computed after the PCM is ready, immediately before
  `start`;
- volume changes only the gain and do not re-render or restart the hit;
- physics changes are coalesced into one latest rebuild through a cancellable
  scheduler; `stop`, `dispose` and a new hit invalidate pending rebuilds;
- `realPcmEnvironment` owns an `AudioContext` created lazily on first hit.

Realtime DSP uses `WorkletSession`. The consumer owns the processor module and
its bundling, and passes a ready `moduleUrl` and `processorName`. There is no
shared virtual worklet module, plugin or global worklet entry point.

- `start()` is transactional: context creation is registered immediately, and a
  graph is published only after the gain ramp, config and parameters succeed; a
  failure rolls back created resources. Concurrent starts share the same
  attempt.
- `processorerror` retires the current graph. `onError(error, info)` reports
  whether the error belongs to the current graph generation; late cleanup of a
  retired graph has `current: false`.
- `onEvent(payload)` is an opt-in receiver for processor messages other than
  `state`/`error`. The payload is `unknown`; the consumer validates its schema.
  The SDK does not define a musical message protocol.
- `contextState` is the real state of the session-owned `AudioContext`. Graph
  lifecycle flags such as `running`/`status` are not the audio-context state and
  are not a musical transport.
- `resumeContext()` resumes only an existing graph or pending context and never
  creates a graph or module. Its boolean means the target was still owned when
  the native resume completed, not that playback or a musical Resume succeeded.
- `dispose()` releases the current graph and any unfinished start, closes each
  owned resource once, and rejects with the real local cleanup error.

The SDK does not provide a musical transport or schedule consumer commands.
PCM's scheduler coalesces physical rebuilds; it is not a transport. Worklet
publication queues, revisions, epochs, acknowledgements and control ordering
belong to the consumer. After disposal or graph replacement, the consumer must
not apply late acknowledgements or resume outcomes.

## MIDI

There is one Web MIDI implementation for the kit. `MidiMapping` values address
parameter and action registry ids, not DOM elements; synthetic DOM events are
not a routing mechanism.

- The adapter handles connection, hotplug, reconnect, per-mapping channel,
  learn, create/update/remove, persistence, disabled-target protection,
  edge-triggered CC actions and per-message Note On action triggers.
- Action mappings: CC is edge-triggered at threshold 64 (held values do not
  repeat; dropping below 64 re-arms the next raise). Every valid Note On with
  positive velocity invokes the action, even while the same note/channel is
  held; Note Off (including Note On velocity 0) never invokes. Duplicate rows
  for one target still execute once per incoming message.
- By default it listens to the first available input; the panel can select all
  inputs. Mappings remain shared, and note holds and relative-CC history are
  keyed by `(inputId, channel)`, so devices do not release each other's holds.
- Mappings are supported only for `number`, `boolean` and `action` targets.
  Enum targets are dropped on load with a warning.
- `subscribeInput(listener)` is an opt-in stream of the same adapter's musical
  input events. It does not create a second `requestMIDIAccess` or touch the
  DOM. Messages carry an independent readonly snapshot, learn/mapping flags and
  a scoped `input-reset` event on input removal. The SDK does not filter
  messages by routing flags; a local instrument decides that policy.
- An action mapping calls `actions.execute(target, "midi", input)` with a
  `MidiActionInput` that contains a frozen message snapshot captured before
  monitoring. `midiNoteVelocity(input)` returns a Note On velocity in `0..1`,
  returns `undefined` for non-MIDI, CC and Note Off payloads, and raises an
  explicit error for a malformed MIDI payload.
- Persistence uses the versioned namespace `labkit.midi.<namespace>.v2` with a
  v1-to-v2 migration. An unknown version is not read and its reason is reported;
  legacy shapes are not guessed. Unavailable storage is disabled, not replaced
  by in-memory storage. Persistence errors are visible and do not disable MIDI.
- `attachMidi(ctx, lifetime, options)` creates the adapter, panel and non-modal
  settings window, binds the inline learn slots that the layout renderer already
  built before `hooks.setup`, and registers cleanup in the instance lifetime.
  The connection is initiated by an explicit user gesture; closing the settings
  window does not disconnect MIDI, disable learning or recreate adapter state.
- Web MIDI requires a secure context. Whether the `midi` capability is
  `required` or `optional` is declared by the consuming `LabDefinition`, not by
  the SDK.

## Public helpers

The root export also keeps generic PCM helpers (`PcmGraph`, `PcmPlayer`,
`createPcmBuffer`, `realPcmEnvironment`) and canvas plot helpers (`linearScale`,
`sampleSeries`, `drawGrid`, `drawZeroAxes`, `drawPolyline`, `drawXTickLabels`).
They are building blocks and do not add a laboratory definition or a musical
transport.
