// Required capabilities fail mounting; missing optional capabilities are reported independently.

export type CapabilityId = "canvas" | "audioContext" | "audioWorklet" | "worker" | "midi";

export interface CapabilityInfo {
  supported: boolean;
  reason?: string;
}

export type CapabilityReport = Record<CapabilityId, CapabilityInfo>;

export interface CapabilityStatus {
  id: CapabilityId;
  supported: boolean;
  required: boolean;
  reason?: string;
}

/** Абстракция среды — позволяет тестировать определение без реального браузера. */
export interface CapabilityEnvironment {
  isSecureContext: boolean;
  hasDocument: boolean;
  hasCanvas2d: boolean;
  hasAudioContext: boolean;
  hasAudioWorkletNode: boolean;
  hasWorker: boolean;
  hasRequestMidiAccess: boolean;
}

export function browserCapabilityEnvironment(): CapabilityEnvironment {
  const g = globalThis as unknown as Record<string, unknown>;
  const hasDocument = typeof document !== "undefined";
  let hasCanvas2d = false;
  if (hasDocument) {
    try {
      hasCanvas2d = !!document.createElement("canvas").getContext("2d");
    } catch {
      hasCanvas2d = false;
    }
  }
  return {
    isSecureContext: typeof g.isSecureContext === "boolean" ? g.isSecureContext : false,
    hasDocument,
    hasCanvas2d,
    hasAudioContext: typeof g.AudioContext === "function",
    hasAudioWorkletNode: typeof g.AudioWorkletNode === "function",
    hasWorker: typeof g.Worker === "function",
    hasRequestMidiAccess: typeof navigator !== "undefined" && "requestMIDIAccess" in navigator,
  };
}

export function detectCapabilities(
  env: CapabilityEnvironment = browserCapabilityEnvironment(),
): CapabilityReport {
  const canvas: CapabilityInfo =
    env.hasDocument && env.hasCanvas2d
      ? { supported: true }
      : { supported: false, reason: "нет DOM или 2D-контекста canvas" };

  // PCM-плееру нужен только конструктор AudioContext; feature-check НЕ создаёт
  // контекст и не требует secure context (в отличие от audioWorklet/MIDI).
  const audioContext: CapabilityInfo = env.hasAudioContext
    ? { supported: true }
    : { supported: false, reason: "AudioContext недоступен" };

  const audioWorklet: CapabilityInfo =
    !env.hasAudioContext || !env.hasAudioWorkletNode
      ? { supported: false, reason: "AudioWorklet недоступен" }
      : !env.isSecureContext
        ? { supported: false, reason: "AudioWorklet требует secure context" }
        : { supported: true };

  const worker: CapabilityInfo = env.hasWorker
    ? { supported: true }
    : { supported: false, reason: "Web Worker недоступен" };

  const midi: CapabilityInfo = !env.hasRequestMidiAccess
    ? { supported: false, reason: "Web MIDI недоступен" }
    : !env.isSecureContext
      ? { supported: false, reason: "Web MIDI требует secure context" }
      : { supported: true };

  return { canvas, audioContext, audioWorklet, worker, midi };
}

export function checkCapabilities(
  report: CapabilityReport,
  required: readonly CapabilityId[],
  optional: readonly CapabilityId[] = [],
): CapabilityStatus[] {
  const seen = new Set<CapabilityId>();
  const statuses: CapabilityStatus[] = [];
  for (const id of required) {
    if (seen.has(id)) continue;
    seen.add(id);
    const info = report[id];
    statuses.push({
      id,
      supported: info.supported,
      required: true,
      ...(info.reason ? { reason: info.reason } : {}),
    });
  }
  for (const id of optional) {
    if (seen.has(id)) continue;
    seen.add(id);
    const info = report[id];
    statuses.push({
      id,
      supported: info.supported,
      required: false,
      ...(info.reason ? { reason: info.reason } : {}),
    });
  }
  return statuses;
}

export class CapabilityError extends Error {
  readonly missing: CapabilityId[];
  readonly statuses: CapabilityStatus[];

  constructor(missing: CapabilityId[], statuses: CapabilityStatus[]) {
    super(`labkit: отсутствуют обязательные возможности: ${missing.join(", ")}`);
    this.name = "CapabilityError";
    this.missing = missing;
    this.statuses = statuses;
  }
}

/** Текст для UI: поддержанные/неподдержанные возможности с причинами. */
export function formatCapabilityStatuses(statuses: readonly CapabilityStatus[]): string {
  if (statuses.length === 0) return "";
  return statuses
    .map((s) => {
      const mark = s.supported ? "✓" : "✗";
      const scope = s.required ? "обязательна" : "опциональна";
      const reason = s.supported ? "" : ` — ${s.reason ?? "недоступна"}`;
      return `${mark} ${s.id} (${scope})${reason}`;
    })
    .join("\n");
}
