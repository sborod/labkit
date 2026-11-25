# MIDI

LabKit handles Web MIDI access, parameter/action mappings, learning and the
settings panel. Mappings address registry ids, not DOM elements.

## Integrate MIDI

Declare `midi` as an optional or required capability in the lab definition.
In `hooks.setup`:

```ts
import { attachMidi, realMidiEnvironment } from "labkit";

// Inside hooks.setup(ctx, lifetime):
attachMidi(ctx, lifetime, {
  namespace: "my-lab",
  environment: realMidiEnvironment,
});
```

Use a unique, stable namespace for each lab. The helper owns setup and cleanup,
including the MIDI panel and inline learn buttons. It does not request access
until the user connects. The [starter template](../../templates/lab-template/)
shows the complete integration and a fake environment in tests.

For musical notes beyond mapped actions, use the returned adapter's
`subscribeInput`; do not create another input adapter.

## Files

- `types.ts` — types (`MidiMapping`, `MidiMessage`, `MidiInputEvent`,
  `MidiActionInput`, statuses, environments).
- `action-input.ts` — `midiNoteVelocity(input)`: narrows an action payload to
  Note On velocity (`0..1`) with an explicit error for a malformed
  `MidiActionInput`.
- `decode.ts` — strict CC/Note decoding and relative modes.
- `store.ts` — versioned namespace `labkit.midi.<namespace>.v2` (with v1
  migration).
- `adapter.ts` — `MidiAdapter`: connection/hotplug/reconnect, channel per
  mapping, learn, CRUD, persistence, registry dispatch, disabled-target
  protection, CC-action edge triggers, repeated Note On action triggers, opt-in
  `subscribeInput` stream.
- `inline.ts` — inline learn: compact slot buttons next to every supported
  parameter/action (`bindMidiLearn`).
- `panel.ts` — shared UI panel (`createMidiPanel`).
- `attach.ts` — `attachMidi`: creates the adapter, panel and settings window,
  binds the layout's existing inline learn slots, and registers cleanup in an
  instance lifetime.
- `window.ts` — non-modal settings window and top MIDI buttons.
- `environment.ts` / `testing.ts` — production and fake environments (seam).

## Inputs or all inputs

### Output access

`realMidiEnvironment.requestAccess()` returns the same `MidiAccessLike` with live
`inputs` and `outputs`. `outputs` is optional for compatibility with older test
or user environments; its absence means no outputs are available.
`MidiOutputLike` provides `id`, `name`, `state` and `send(data)`. Input and output
changes use the same independent state-change listeners. `testing.ts` provides
fake outputs that record sent messages.

This is only Web MIDI access, not an output framework: output selection, Note Off
and panic belong to the local consumer instrument. MIDI Out does not need a
mounted MIDI In adapter/learn, and must not create a second Web MIDI stack. MIDI
Out settings do not use mapping persistence.

### Adapter inputs

By default the adapter listens to the first available input. The panel can select
**"All inputs"** (`selectAllInputs()`): the adapter subscribes to all connected
devices at once, and hotplug automatically adds and removes listeners.

- Mappings remain shared: the same CC/Note from different devices controls the
  same target. Identical numbers cannot be separated per device — that would
  require an `inputId` binding in the mapping (not implemented).
- Learn is triggered by any active input and records the actual message channel
  in the mapping.
- Note holds and relative CC history are keyed by `(inputId, channel)`: a Note
  Off from one controller does not release a note held by another, even when the
  channels match.
- Disconnecting one device releases only its holds; the others keep working.
- The mode and selected input are not persisted between sessions. A consumer may
  enable a default mode with the `inputMode: "all"` option in `attachMidi`.

## Opt-in musical event stream

A consumer that needs the notes themselves (a local instrument rather than only
parameters/actions) subscribes to the stream of the same instance:

```ts
const unsubscribe = midi.subscribeInput((event) => {
  if (event.type === "message") {
    // event.inputId, readonly event.message, routing flags
  } else {
    // event.inputId, event.reason: "disconnect" | "selection" | "dispose"
  }
});
```

`attachMidi` already returns `midi`; a second adapter, a second
`requestMIDIAccess` and consumer-owned port listeners are not needed. The
subscription addresses a local instrument, not the DOM. Mappings still address
only the registry.

Event type:

```ts
type MidiInputEvent =
  | {
      type: "message";
      inputId: string;
      message: Readonly<MidiMessage>;
      consumedByLearn: boolean;
      matchedMapping: boolean;
    }
  | { type: "input-reset"; inputId: string; reason: "disconnect" | "selection" | "dispose" };
```

Delivery order: input check/decoding → existing `onMonitor` → learn **or** normal
registry dispatch → musical subscribers → UI `onChange` (for learn, UI notify has
already happened inside learning). A subscriber therefore sees the value already
applied to the registry. An error from one subscriber goes to `onError` and does
not block the others. The exception is a listener for the terminal reset after
`dispose`: the error is logged via `console.error` under the existing
post-dispose policy.

- `consumedByLearn` — the message was consumed by learning (CC or Note On).
  Normal mapping dispatch does not run, but subscribers still receive the event
  with `consumedByLearn=true`.
- `matchedMapping` — a row with the same `source`/`number`/`channel` exists,
  **regardless** of target availability. Flags are captured before any
  learn/CRUD mutation.
- The SDK does **not filter** messages by routing flags. The local instrument
  decides whether to suppress Note On after learn/matched mapping; it must always
  accept Note Off and CC release (for example CC64=0).
- `message` is an independent readonly snapshot (a frozen copy of the decoded
  message), not a reference to `event.data`, the mapping or the `onMonitor`
  object. Another subscriber cannot mutate the snapshot for later subscribers.
- A subscriber that unsubscribes during iteration is skipped; between subscribers
  the adapter checks `disposed`, selection revision and input activity. Changing
  the input or disposing from a callback cancels delivery of the old message to
  the remaining subscribers.
- `input-reset` is scoped to one input: disconnecting one device does not reset
  the others. `disconnect` — hotplug/disconnect (refresh), `selection` — explicit
  `selectInput`/`selectAllInputs`, `dispose` — terminal reset during release. No
  extra reset is emitted for inputs that remain in the set. The reset arrives
  after message/revision invalidation and membership removal. The reset
  obligation is recorded BEFORE external registry callbacks, so
  `dispose`/`selectInput` from a release callback, `onMonitor(null)` or another
  reset listener does not lose the release of an already-removed input; the queue
  is bounded by the number of inputs and is drained by an external call.
  Re-adding the same `inputId` does **not** cancel an already recorded reset: it
  closes the previous holdings period, and a new period starts after the reset is
  delivered.
- `dispose` is idempotent: first it closes normal delivery, then delivers
  terminal resets for previously active inputs to remaining subscribers, and only
  then clears listeners/resources. There are no messages after dispose;
  subscribing after dispose is a no-op. Reset is not the only protection: a
  consumer resets local notes and unsubscribes in its own LIFO cleanup.

## MIDI action payload

When a mapping addresses an action, the adapter calls
`actions.execute(target, "midi", input)` with an optional `MidiActionInput`:

```ts
type MidiActionInput = Readonly<{
  kind: "midi";
  inputId: string;
  message: Readonly<MidiMessage>;
}>;
```

`input` is the opaque payload of the current invocation; the core does not clone
or freeze it. The adapter passes a frozen snapshot of the original message
(source, number, channel, value, on) captured **before** `onMonitor`; monitor and
`lastMessage` changes do not affect it. An action can narrow `ctx.input` with the
helper:

```ts
import { midiNoteVelocity } from "labkit";

run: (ctx) => {
  const velocity = midiNoteVelocity(ctx.input); // 0..1 or undefined
  if (velocity === undefined) return; // no MIDI Note On input: e.g. UI or CC
  // Note On: the helper has already validated MidiActionInput fields.
};
```

Each valid Note On is a separate invocation: the same mapped note can retrigger
while held, and every invocation keeps its own frozen message/velocity snapshot
across async work. The helper returns `undefined` for a non-MIDI payload, CC and
Note Off (Note Off may have non-zero release velocity). A malformed payload that
claims `kind: "midi"` is an explicit error with a `labkit:` prefix, not a silent
`undefined`. `ctx.input` remains `unknown`: do not read `ctx.input.message`
without explicit narrowing. The adapter sets `ctx.origin === "midi"`; the helper
checks only `input`, not origin. An API call may also pass a MIDI payload
explicitly.

`lastMessage` and `onMonitor` remain monitoring for UI/diagnostics: they are
mutable and are not a source of routing or musical data. If an instrument needs
the full opt-in note stream, use `subscribeInput`; the assigned-action payload is
the path for a command/short reaction to one mapped CC/Note, not a second stream.

## Mapping channels

Channel is a property of EACH mapping (`MidiMapping.channel`), not of the
adapter: there is no global channel selector.

- `0` — "Any": the mapping accepts a message on any channel;
- `1..16` — only messages on that channel.

Identical CC/Note numbers on different channels can therefore control different
parameters and actions, while devices are still not distinguished (`inputId` is
not stored in a mapping). Learn records the actual message channel in the taught
row (or in a new one). The panel selects a channel per mapping row; changing the
channel releases the row's holds before the mutation so a Note/switch does not
stick. The summary shows a channel only when it is concrete:
`CC 20 · ch 3`, `CC 20 · ch 3 · Δ`, `CC 20 · ch 3 +1`.

## Decoding and modes

- CC `0xB0`, Note On `0x90`, Note Off `0x80`; length is exactly 3, ranges are
  strict.
- Absolute CC → linear scale into `[min,max]`, then **quantization by step with
  the anchor at `min`** (the registry itself only clamps).
- Relative (CC + number only): `delta`, `wrap`, `twos`, `offset`, `sign`. For
  `delta`/`wrap`, the first message on a channel is neutral (anchor without
  change); `twos`/`offset`/`sign` are stateless.
- Switches: CC writes directly (threshold 64, priority over a held Note); Note
  aggregates holds across devices and channels and recalculates on the next Note.
- Actions: a CC is edge-triggered at threshold 64 — held values do not repeat,
  dropping below 64 re-arms the next raise. Every valid Note On with positive
  velocity invokes the action, even when the same note/channel is already held;
  Note Off (including Note On velocity 0) never invokes. Duplicate rows for one
  target still execute once per incoming message. An unavailable action is not
  executed and is marked.
- Learn consumes the trigger message; Note Off does not learn, CC 0 does; a
  repeated learn updates the first mapping of the target. An opt-in subscriber
  receives the consumed message with `consumedByLearn=true`.
- Reconnect: the selected (wanted) input is not replaced by another; inputs are
  listed live (hotplug is visible); state-change uses independent listeners, so
  two instances do not interfere.
- **New-mapping mode** (`defaultModes`, optional): a per-target mode applies
  **only to new** mappings (creation and learning). An explicit or stored mode is
  not overwritten; without the option new mappings are `absolute`; a relative
  default makes sense only for number targets.
- **Multiple mappings per target** are allowed and applied sequentially, each
  with its own history per (device, channel) pair.

## Persistence and reliability

- The storage schema is strictly versioned (`v2`); a version mismatch means the
  state is not read and the reason is reported; legacy formats are not guessed.
  The channel is stored in every row; there is no global `channel` in v2.
- v1 → v2 migration: if the v2 key is absent, `labkit.midi.<namespace>.v1` is
  read, the global channel (0..16, invalid → 0) is copied into every row, and the
  result is immediately saved to v2. The old v1 key is not deleted. If the
  migration write fails, rows stay in memory, the error is reported, and v1 is
  read again next time. An existing v2 (even corrupted) is never rolled back to
  v1.
- Restored ids are unique; new ids skip occupied ones (otherwise rows would share
  runtime holds).
- Holds are released on remove/update/relearn/dispose and recalculated from the
  remaining rows (a switch does not stick).
- For relative modes, channel history is updated even when the parameter is
  unavailable (no write is performed), so re-enabling does not produce a jump.
- Read/write errors or unavailable `localStorage` do not break the MIDI adapter:
  `onError` + `persistenceWarning` are visible in the panel, and the adapter
  remains usable. Unavailable persistence is DISABLED (nullable storage), not
  replaced by in-memory storage; a successful write clears the warning.
- Native isolation: `statechange` uses `addEventListener`, not a shared
  `onstatechange`; another handler is preserved, and two wrappers on one access
  are independent.
- Only `number`/`boolean`/`action` are addressable; enum targets are dropped on
  load with a warning. Dispose from an external callback (onStatus/onChange/
  registry subscriber) stops further actions immediately; `update`/`remove` do
  not write after registry dispose (a replacement is not overwritten).
- The current message is invalidated if `onMonitor` changes the input: the old
  message is not dispatched, does not teach the new input and does not reach
  musical subscribers; the removed input receives a scoped `input-reset`.
- Learning: row-level (`startLearn(target, mappingId)`) changes exactly that row;
  without an id, the first mapping of the target. The panel's draft path chooses
  the first available target.

## Settings window and UI learning

`attachMidi` mounts a non-modal window on the right, closed by default; on mobile
it occupies the available width. A "MIDI" button in the header shows textual
status and opens settings (without a header, buttons are added to the root). The
window is positioned below the actual header boundary, including wrapping of
pending and cancel states; resize/scroll update position and available height.
When the header is scrolled off screen, the window stays at the top of the
viewport. Observer/listeners are removed on dispose. Connection happens only on
an explicit "Connect MIDI" press, not when the window opens. Closing with the
cross or Escape does not turn MIDI/learning off and does not recreate the
adapter, list or scroll state. Focus returns to the opener only if it is still in
the window; Escape in a numeric editor first cancels editing.

At the top are connection and inputs, followed by compact mappings (target,
CC/Note, channel, "Learn", "Configure"). The expansion keeps all previous fields
and deletion. Rows are reconciled by id without a full rebuild: incoming
messages and learning of another row do not reset the draft, focus or expansion.
The monitor is collapsible at the bottom. On blur the field immediately reflects
the latest canonical state (after a normal change), without waiting for the next
MIDI message. Waiting for MIDI is visible next to the top buttons even when
settings are closed; cancellation is available there too. The window does not
trap focus and does not block the main instrument.

The global "MIDI Learn" button in `.labkit-header-actions` only ENABLES learning
mode: compact buttons appear in slots next to every supported parameter/action
(`bindMidiLearn` in `inline.ts`); there is no duplicate target list in the panel.
User path:

- no mapping → "Learn MIDI"; the click puts the adapter into waiting;
- while waiting → "Waiting for MIDI…" (pressed); the click cancels;
- a mapping exists → `CC n` / `Note n` (with `· ch k` for a concrete channel,
  `· Δ` for a relative mode and `+N` for additional mappings of the target); the
  click relearns the FIRST mapping.

Slots are `[data-labkit-param-accessory]` for number/boolean controls and
`[data-labkit-action-accessory]` for actions; enum gets no slot. Buttons live
inside the control wrapper (hiding it hides the slot) and do NOT copy the main
control's disabled state: a temporarily unavailable target can be assigned in
advance. The binder does not own the adapter and does not change
`training`/`learning`: row-level learning of a specific mapping stays in the
panel editors. `dispose` is idempotent and does not touch the adapter; a failure
while building or on the first refresh rolls back the buttons and subscription.

Mechanics are documented in the `src/midi/` comments. Web MIDI requires a secure
context. Whether the `midi` capability is required or optional is declared by
the consumer's `LabDefinition`, not by the SDK.
