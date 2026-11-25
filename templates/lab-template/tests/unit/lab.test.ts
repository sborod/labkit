// @vitest-environment jsdom
import { detectCapabilities, MemoryMidiStorage } from "labkit";
import { FakeMidiEnvironment } from "labkit/testing";
import { expect, test } from "vitest";
import { mountLab } from "../../mount.ts";
import { createState, DEFAULT_LEVEL } from "../../state.ts";

const services = {
  capabilities: detectCapabilities({
    isSecureContext: true,
    hasDocument: true,
    hasCanvas2d: false,
    hasAudioContext: false,
    hasAudioWorkletNode: false,
    hasWorker: false,
    hasRequestMidiAccess: true,
  }),
};

function mount() {
  const host = document.createElement("div");
  const midiEnvironment = new FakeMidiEnvironment();
  const instance = mountLab(host, services, {
    midiEnvironment,
    midiStorage: new MemoryMidiStorage(),
  });
  return { host, instance, midiEnvironment };
}

test("state is independent", () => {
  const first = createState();
  first.level = 0.9;
  expect(createState().level).toBe(DEFAULT_LEVEL);
});

test("mount, update, reset and dispose through the public SDK", async () => {
  const { host, instance, midiEnvironment } = mount();
  const readout = () => host.querySelector(".labkit-readout-text")?.textContent;
  try {
    expect(readout()).toBe("0.50");
    expect(midiEnvironment.requestCount).toBe(0);
    instance.params.set("level", 0.75, "api");
    instance.render();
    expect(instance.state.level).toBe(0.75);
    expect(readout()).toBe("0.75");
    await instance.actions.execute("reset", "api");
    instance.render();
    expect(readout()).toBe("0.50");
  } finally {
    await instance.dispose();
  }
  expect(instance.disposed).toBe(true);
  expect(host.childElementCount).toBe(0);
});

test("two mounted labs do not share state", async () => {
  const a = mount().instance;
  const b = mount().instance;
  try {
    a.params.set("level", 0.25, "api");
    expect(b.state.level).toBe(DEFAULT_LEVEL);
  } finally {
    await Promise.all([a.dispose(), b.dispose()]);
  }
});
