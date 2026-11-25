// Production-среда worklet: обычный `AudioContext` и `AudioWorkletNode`.
// Никакого webkit-префикса и условной загрузки (ADR 001/002). Возможность
// `audioWorklet` проверяется до монтирования, поэтому конструктор доступен.
import type {
  WorkletAudioContext,
  WorkletEnvironment,
  WorkletNodeLike,
  WorkletNodeOptions,
} from "./worklet.ts";

export const realWorkletEnvironment: WorkletEnvironment = {
  createContext(): WorkletAudioContext {
    return new AudioContext() as unknown as WorkletAudioContext;
  },
  createNode(
    ctx: WorkletAudioContext,
    processorName: string,
    options: WorkletNodeOptions,
  ): WorkletNodeLike {
    return new AudioWorkletNode(ctx as unknown as BaseAudioContext, processorName, {
      numberOfOutputs: options.numberOfOutputs,
      outputChannelCount: options.outputChannelCount,
    }) as unknown as WorkletNodeLike;
  },
  resumeContext(ctx: WorkletAudioContext): Promise<void> {
    return ctx.state === "suspended" ? ctx.resume() : Promise.resolve();
  },
  closeContext(ctx: WorkletAudioContext): Promise<void> {
    return ctx.close();
  },
};
