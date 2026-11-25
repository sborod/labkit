import { PcmGraph, createPcmBuffer } from "../../../src/audio/pcm.ts";

// Direct SDK import: the tests build and render the production PcmGraph API,
// without mounting a real lab or relying on a browser host protocol.
declare global {
  interface Window {
    __pcmFixture: {
      PcmGraph: typeof PcmGraph;
      createPcmBuffer: typeof createPcmBuffer;
    };
  }
}

window.__pcmFixture = { PcmGraph, createPcmBuffer };
