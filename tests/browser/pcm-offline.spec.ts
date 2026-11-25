import { expect, test } from "@playwright/test";

// OfflineAudioContext в реальном Chromium. Граф собирается ТЕМ ЖЕ кодом, что и
// production-плеер (PcmGraph/createPcmBuffer через SDK-owned fixture), а не
// скопированным в тест. Это проверка аудиографа (маршрутизация/gain/замена/offset/
// окончание), а не физической модели — модель проверяют численные эталоны.

const FIXTURE = "pcm-offline.html";

test("маршрутизация source → gain → destination и gain=0.5", async ({ page }) => {
  await page.goto(FIXTURE);
  const out = await page.evaluate(async () => {
    const api = window.__pcmFixture;
    const { PcmGraph, createPcmBuffer } = api;
    const ctx = new OfflineAudioContext(1, 256, 44100);
    const graph = new PcmGraph(ctx, ctx.destination);
    graph.setVolume(0.5);
    graph.play(createPcmBuffer(ctx, new Float32Array(128).fill(0.5)), 0, () => {});
    const rendered = await ctx.startRendering();
    const data = rendered.getChannelData(0);
    return { first: data[0], mid: data[100], tail: data[200] };
  });
  expect(out.first).toBeCloseTo(0.25, 5);
  expect(out.mid).toBeCloseTo(0.25, 5);
  expect(out.tail).toBe(0);
});

test("mute (gain = 0) даёт тишину", async ({ page }) => {
  await page.goto(FIXTURE);
  const peak = await page.evaluate(async () => {
    const api = window.__pcmFixture;
    const { PcmGraph, createPcmBuffer } = api;
    const ctx = new OfflineAudioContext(1, 256, 44100);
    const graph = new PcmGraph(ctx, ctx.destination);
    graph.setVolume(0);
    graph.play(createPcmBuffer(ctx, new Float32Array(128).fill(1)), 0, () => {});
    const rendered = await ctx.startRendering();
    return Math.max(...rendered.getChannelData(0));
  });
  expect(peak).toBe(0);
});

test("замена source стартует со смещением (offset пропускает начало буфера)", async ({ page }) => {
  await page.goto(FIXTURE);
  const out = await page.evaluate(async () => {
    const api = window.__pcmFixture;
    const { PcmGraph, createPcmBuffer } = api;
    const ctx = new OfflineAudioContext(1, 256, 44100);
    const graph = new PcmGraph(ctx, ctx.destination);
    graph.setVolume(1);
    // Старый буфер заменяется новым; новый стартует с offset 32 сэмпла (в секундах).
    graph.play(createPcmBuffer(ctx, new Float32Array(128).fill(1)), 0, () => {});
    graph.play(createPcmBuffer(ctx, new Float32Array(128).fill(0.5)), 32 / 44100, () => {});
    const rendered = await ctx.startRendering();
    const data = rendered.getChannelData(0);
    return { first: data[0], last: data[95], tail: data[160] };
  });
  expect(out.first).toBeCloseTo(0.5, 5);
  expect(out.last).toBeCloseTo(0.5, 5);
  expect(out.tail).toBe(0);
});

test("изменение громкости на границе quantum (suspend = 128 сэмплов)", async ({ page }) => {
  await page.goto(FIXTURE);
  const out = await page.evaluate(async () => {
    const api = window.__pcmFixture;
    const { PcmGraph, createPcmBuffer } = api;
    const ctx = new OfflineAudioContext(1, 256, 44100);
    const graph = new PcmGraph(ctx, ctx.destination);
    graph.setVolume(1);
    graph.play(createPcmBuffer(ctx, new Float32Array(256).fill(1)), 0, () => {});
    // suspend принимает время в секундах; 128 сэмплов — ровно render quantum.
    void ctx.suspend(128 / 44100).then(() => {
      graph.setVolume(0.25);
      void ctx.resume();
    });
    const rendered = await ctx.startRendering();
    const data = rendered.getChannelData(0);
    return { lastBefore: data[127], firstAfter: data[128], later: data[200] };
  });
  expect(out.lastBefore).toBeCloseTo(1, 5);
  expect(out.firstAfter).toBeCloseTo(0.25, 5);
  expect(out.later).toBeCloseTo(0.25, 5);
});

test("mid-render замена через suspend: точный offset от anchor, без наложения, quantum-aware", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  const out = await page.evaluate(async () => {
    const api = window.__pcmFixture;
    const { PcmGraph, createPcmBuffer } = api;
    const sr = 44100;
    const N = 1024;
    const ctx = new OfflineAudioContext(1, N, sr);
    const graph = new PcmGraph(ctx, ctx.destination);
    graph.setVolume(1);
    // Временны́е метки: значения кодируют индекс сэмпла (различимые секции).
    const ramp = (base: number) => Float32Array.from({ length: N }, (_, i) => base + i / sr);
    const A = ramp(0);
    const B = ramp(10);
    const C = ramp(20);
    graph.play(createPcmBuffer(ctx, A), 0, () => {});
    const anchor = ctx.currentTime; // 0

    const k1 = 2;
    const k2 = 6;
    const t1 = (k1 * 128) / sr;
    const t2 = (k2 * 128) / sr;
    let observed1 = -1;
    let observed2 = -1;

    // Первая замена на границе quantum k1.
    void ctx.suspend(t1).then(() => {
      observed1 = ctx.currentTime - anchor;
      graph.play(createPcmBuffer(ctx, B), observed1, () => {});
      void ctx.resume();
    });
    // Вторая замена на границе quantum k2.
    void ctx.suspend(t2).then(() => {
      observed2 = ctx.currentTime - anchor;
      graph.play(createPcmBuffer(ctx, C), observed2, () => {});
      void ctx.resume();
    });

    const data = (await ctx.startRendering()).getChannelData(0);
    // Буфер ограничен 1024 сэмплами; утверждение нужно только для типизации.
    const at = (i: number) => data[i]!;
    return {
      t1,
      t2,
      observed1,
      observed2,
      // A-секция
      v0: at(0),
      a255: at(255),
      // B-секция (start frame = k1*128)
      b256: at(256),
      b767: at(767),
      // C-секция (start frame = k2*128)
      c768: at(768),
      c1023: at(1023),
      expectedA255: 255 / sr,
      expectedB256: 10 + 256 / sr,
      expectedB767: 10 + 767 / sr,
      expectedC768: 20 + 768 / sr,
      expectedC1023: 20 + 1023 / sr,
    };
  });

  // Точное время suspend (quantum) и offset от первоначального anchor.
  expect(Math.abs(out.observed1 - out.t1)).toBeLessThan(1e-9);
  expect(Math.abs(out.observed2 - out.t2)).toBeLessThan(1e-9);
  // До замены — секция A.
  expect(out.v0).toBeCloseTo(0, 6);
  expect(Math.abs(out.a255 - out.expectedA255)).toBeLessThan(1e-4);
  // Граница: без наложения (значение B, а не сумма A+B).
  expect(Math.abs(out.b256 - out.expectedB256)).toBeLessThan(1e-4);
  expect(Math.abs(out.b767 - out.expectedB767)).toBeLessThan(1e-4);
  // Вторая граница: секция C.
  expect(Math.abs(out.c768 - out.expectedC768)).toBeLessThan(1e-4);
  expect(Math.abs(out.c1023 - out.expectedC1023)).toBeLessThan(1e-4);
});

test("окончание буфера: после конца сигнала тишина", async ({ page }) => {
  await page.goto(FIXTURE);
  const out = await page.evaluate(async () => {
    const api = window.__pcmFixture;
    const { PcmGraph, createPcmBuffer } = api;
    const ctx = new OfflineAudioContext(1, 256, 44100);
    const graph = new PcmGraph(ctx, ctx.destination);
    graph.setVolume(1);
    graph.play(createPcmBuffer(ctx, new Float32Array(64).fill(0.75)), 0, () => {});
    const rendered = await ctx.startRendering();
    const data = rendered.getChannelData(0);
    return { inside: data[32], after: data[100] };
  });
  expect(out.inside).toBeCloseTo(0.75, 5);
  expect(out.after).toBe(0);
});
