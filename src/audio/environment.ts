// Production-среда PCM: собственный AudioContext, создаваемый лениво первым
// ударом. Никакого webkitAudioContext и никаких условных веток загрузки
// (ADR 001/002). Наличие AudioContext проверяется возможностью `audioContext`
// до монтирования лаборатории, поэтому здесь конструктор доступен всегда.
import type { PcmAudioContext, PcmEnvironment } from "./pcm.ts";

export const realPcmEnvironment: PcmEnvironment = {
  createContext(): PcmAudioContext {
    return new AudioContext();
  },
  resumeContext(ctx: PcmAudioContext): Promise<void> {
    const audio = ctx as AudioContext;
    if (audio.state === "suspended") {
      return audio.resume();
    }
    return Promise.resolve();
  },
  closeContext(ctx: PcmAudioContext): Promise<void> {
    return (ctx as AudioContext).close();
  },
};
