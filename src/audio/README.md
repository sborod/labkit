# Audio

PCM and realtime DSP (AudioWorklet) are different execution models, not
fallbacks for each other. This SDK provides both; `PeriodicWave` is not
implemented.

## Choose an audio model

| Model        | Use when                                                    | Public API                                    |
| ------------ | ----------------------------------------------------------- | --------------------------------------------- |
| PCM          | The lab renders a sample buffer for playback or replacement | `PcmPlayer`, `PcmGraph`, `realPcmEnvironment` |
| AudioWorklet | The lab runs sample-by-sample DSP in a processor            | `WorkletSession`, `realWorkletEnvironment`    |

Create the player/session in `hooks.setup`, register its `dispose()` with the instance
lifetime, and start audio from a user-triggered action. Do not create audio contexts
during mounting. Use the fake environments from `labkit/testing` in tests.

The [runtime contract](../../docs/CONTRACT.md) defines shared lifetime and error guarantees.

## PCM

- `pcm.ts` — production PCM model: `PcmGraph` (source → gain → destination) and
  `PcmPlayer` (hit/replace/stop policy). The same graph is used by the production
  player and by offline audio-graph checks; it is not duplicated in consumers.
- `environment.ts` — `realPcmEnvironment`: an own `AudioContext`, created lazily
  on the first hit. No `webkitAudioContext`.
- `testing.ts` — narrow test seam (`FakeAudioEnvironment`, `FakeScheduler`). Not a
  production path.

Signal source and key invariants:

- `PcmSource { key(): string; render(sampleRate): Float32Array }` — the consumer
  supplies a physics key and renders the signal; **volume is not part of the
  key**.
- **First-hit anchor.** A new hit sets a new anchor; replacing the buffer keeps
  the previous one. `elapsed = currentTime − anchor` is computed after the PCM is
  ready, immediately before `start`.
- **Volume only through gain.** Changing volume immediately updates gain and does
  not render PCM or restart the hit; a volume-only change does not trigger a
  rebuild. Physics changes are coalesced into one latest rebuild through a
  cancellable scheduler; `stop`/`dispose`/a new hit invalidate pending resume and
  a deferred rebuild.

Detailed invariants live in the comments in `pcm.ts`.

## AudioWorklet

- `worklet.ts` — `WorkletSession` and `WorkletEnvironment` types: transactional
  `start()` (the context is created before the first await and registered as
  pending immediately; the graph is published only after gain ramp, config and
  params; a failure rolls back what was created; the start promise is cached, so
  a concurrent `start()` returns the same attempt), node → analyser → gain →
  destination (analyser before master), mute/master ramp, `setParams` (a partial
  patch is merged)/`resetDsp`/`sendCommand`, `processorerror` retires the graph,
  telemetry by subscription, and idempotent/awaitable `dispose`. `dispose()`
  releases only the CURRENT graph and an unfinished start: it disconnects them
  and calls `close` once per resource, awaiting exactly those calls (but not an
  unfinished `resume`), and rejects with the real local cleanup error. Previously
  retired contexts (`processorerror`, start rollback) close themselves and are not
  a release barrier. After awaiting the initial `resume`/`addModule`, current
  ownership is revalidated, so late continuations do not publish a graph or
  status.
- `onError(error, info: WorkletErrorInfo)` — `info.current` shows whether the
  error belongs to the current generation: a late cleanup of a retired graph is
  `false`.
- `onEvent?(payload: unknown)` — narrow opt-in receiver for processor messages
  other than `state`/`error`. The consumer validates the schema; the SDK does not
  define a musical protocol. The same current-graph/dispose checks apply; an
  exception from the callback is forwarded to the existing `onError`.
- `contextState: WorkletContextState` — the real state of the session-owned
  `AudioContext` (`none | suspended | running | closed | interrupted | unknown`);
  `none` means there is no context (before start, after dispose/rollback/
  `processorerror`), `unknown` means a state outside the known set. It reads the
  context of the current graph or unfinished start; the context itself is not
  exposed. `running`/`hasContext`/`status` describe graph lifecycle, not the audio
  context state (`WorkletStatus` is not a musical transport): a published graph
  may be `suspended`.
- `resumeContext(): Promise<boolean>` — resumes **only an existing** context
  (the published graph or an unfinished start), without creating a graph, nodes
  or module and without changing the `WorkletStatus` lifecycle. Every explicit
  call synchronously makes a new native attempt before the first await: a pending
  start resume is not reused, because user activation belongs to the new gesture.
  `start()` keeps separate semantics: it coalesces only its own start/graph
  creation attempt, and is a no-op when a graph is published.
  `true` only means that the specific target (graph or pending context) was
  still owned by the session when the native resume completed; it is not proof
  of actual playback or of a successful musical Resume; the caller checks
  `contextState` separately if needed. `true` does not replace local
  epoch/sequence/lifetime checks. `false` means the target was retired
  (`dispose`/`lifetime.disposed`, `processorerror`, rollback/start replacement):
  a late resolve/reject is absorbed.
  A current native reject rejects the promise without `onError` and without a
  status change. The currentness check takes generation/lifetime and target
  identity (`graph === target` or `pending === target`) into account, so a
  rollback without a generation change also yields `false`. Before `start`,
  after graph retirement and after `dispose` it refuses. `dispose()` does not wait
  for a stuck resume, `close` runs once, and the context remains owned by the
  session.
- `worklet-environment.ts` — `realWorkletEnvironment` (regular `AudioContext` and
  `AudioWorkletNode`).
- `worklet-testing.ts` — `FakeWorkletEnvironment` and fake nodes with failpoints
  (resume/module/node/connect/close/gain-ramp). Not a production path.

Processor bundling is the consumer's responsibility: the consumer's processor
build must produce an ESM module and pass its URL as `moduleUrl` (for example,
through a Vite worker import with `worker.format: "es"`). The SDK only accepts
the ready `moduleUrl` and `processorName`; it defines no shared virtual module,
plugin or global worklet entry point, and knows nothing about concrete consumers.
The processor is an ordinary ESM build artifact, not a `data:` URL or generated
string.

## Contract

Declarations live in [`src/audio/worklet.ts`](worklet.ts):
[`WorkletEnvironment`](worklet.ts), [`WorkletSessionOptions`](worklet.ts),
[`WorkletErrorInfo`](worklet.ts), [`WorkletContextState`](worklet.ts),
[`WorkletSession`](worklet.ts).

Telemetry is emitted by the consumer's scheduler exactly on an interval boundary
in samples and is NOT returned to the DSP. The shared `WorkletSession` classifies
`type: "state"` messages as telemetry and hands other user messages to the
optional `onEvent`; it does not depend on a concrete DSP module.

Offline checks (`OfflineAudioContext`) prove the audio graph, not the physical
model.

## Consumer boundary

The SDK does not provide a musical transport or schedule consumer commands.
PCM has its own scheduler for coalescing physical rebuilds; it is not a
transport. Pending publication queues, revisions, epochs and control ordering
stay local to the consumer. After `dispose` or graph replacement, late
acknowledgements and resume outcomes must not be applied.
