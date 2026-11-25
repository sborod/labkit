import { expect, test } from "@playwright/test";

const FIXTURE = "lifecycle.html";

test("SDK instances are isolated; dispose is idempotent, removes DOM, and permits remount", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  const result = await page.evaluate(async () => {
    const mount = window.__lifecycleFixture.mount;
    const hostA = document.createElement("div");
    const hostB = document.createElement("div");
    document.body.append(hostA, hostB);
    const a = mount(hostA);
    const b = mount(hostB);
    a.params.set("value", 3, "api");
    const before = { a: a.state.value, b: b.state.value };

    const first = a.dispose();
    const second = a.dispose();
    const samePromise = first === second;
    await first;
    b.params.set("value", 2, "api");
    const afterA = {
      value: a.state.value,
      disposed: a.disposed,
      roots: hostA.querySelectorAll(".labkit").length,
      canvases: hostA.querySelectorAll("canvas").length,
    };
    const afterB = {
      value: b.state.value,
      roots: hostB.querySelectorAll(".labkit").length,
      canvases: hostB.querySelectorAll("canvas").length,
    };
    await b.dispose();
    const afterBDispose = {
      roots: hostB.querySelectorAll(".labkit").length,
      canvases: hostB.querySelectorAll("canvas").length,
    };

    const remountHost = document.createElement("div");
    document.body.append(remountHost);
    const firstMount = mount(remountHost);
    await firstMount.dispose();
    const secondMount = mount(remountHost);
    const remount = {
      roots: remountHost.querySelectorAll(".labkit").length,
      canvases: remountHost.querySelectorAll("canvas").length,
    };
    await secondMount.dispose();
    return { before, samePromise, afterA, afterB, afterBDispose, remount };
  });

  expect(result.before).toEqual({ a: 3, b: 1.2 });
  expect(result.samePromise).toBe(true);
  expect(result.afterA).toEqual({ value: 3, disposed: true, roots: 0, canvases: 0 });
  expect(result.afterB).toEqual({ value: 2, roots: 1, canvases: 1 });
  expect(result.afterBDispose).toEqual({ roots: 0, canvases: 0 });
  expect(result.remount).toEqual({ roots: 1, canvases: 1 });
});

test("missing required canvas capability throws CapabilityError without mounting fallback DOM", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  const result = await page.evaluate(() => {
    const mount = window.__lifecycleFixture.mount;
    const host = document.createElement("div");
    document.body.append(host);
    const capabilities = {
      canvas: { supported: false, reason: "no canvas (test)" },
      audioContext: { supported: true },
      audioWorklet: { supported: true },
      worker: { supported: true },
      midi: { supported: true },
    };
    try {
      mount(host, { capabilities });
      return {
        name: "no-throw",
        missing: [],
        roots: host.querySelectorAll(".labkit").length,
        children: host.childElementCount,
      };
    } catch (error) {
      const capabilityError = error as Error & { missing?: string[] };
      return {
        name: capabilityError.name,
        missing: capabilityError.missing ?? [],
        roots: host.querySelectorAll(".labkit").length,
        children: host.childElementCount,
      };
    }
  });

  expect(result.name).toBe("CapabilityError");
  expect(result.missing).toContain("canvas");
  expect(result.roots).toBe(0);
  expect(result.children).toBe(0);
});
