// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControl } from "../../src/ui/controls.ts";
import { knobValue } from "../../src/ui/knob.ts";
import { ParameterRegistry } from "../../src/core/registry.ts";
import type { NumberParamSpec, ParameterSpec } from "../../src/core/params.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  document.body.replaceChildren();
});
function mount(
  overrides: Partial<NumberParamSpec<{ n: number; enabled: boolean; visible: boolean }>> = {},
) {
  const state = { n: 0.5, enabled: true, visible: true };
  const spec: NumberParamSpec<typeof state> = {
    id: "n",
    label: "Level",
    kind: "number",
    min: 0,
    max: 1,
    step: 0.01,
    format: (n) => `${n * 100}%`,
    read: (s) => s.n,
    write: (s, n) => {
      s.n = n;
    },
    available: (s) => s.enabled,
    visible: (s) => s.visible,
    ...overrides,
  };
  const registry = new ParameterRegistry(state, { n: spec });
  const set = vi.spyOn(registry, "set");
  const control = createControl(spec, registry);
  cleanups.push(control.dispose);
  document.body.append(control.el);
  const slider = control.el.querySelector<HTMLButtonElement>('[role="slider"]')!;
  slider.setPointerCapture = vi.fn();
  const value = control.el.querySelector<HTMLButtonElement>(".labkit-knob-value")!;
  const editor = control.el.querySelector("input")!;
  const pointer = (
    target: EventTarget,
    type: string,
    x = 100,
    shiftKey = false,
    id = 1,
    y = 100,
  ) => {
    const event = new MouseEvent(type, {
      clientX: x,
      clientY: y,
      button: 0,
      shiftKey,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "pointerId", { value: id });
    target.dispatchEvent(event);
  };
  const key = (target: HTMLElement, key: string) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  return { state, registry, set, control, slider, value, editor, pointer, key };
}

interface BoundState {
  a: number;
  b: number;
  selected: "a" | "b";
}

function mountBound(withBindingKey = true) {
  const state: BoundState = { a: 20, b: 20, selected: "a" };
  const spec: NumberParamSpec<BoundState> = {
    id: "n",
    label: "Level",
    kind: "number",
    min: 0,
    max: 100,
    step: 1,
    read: (s) => s[s.selected],
    write: (s, n) => {
      s[s.selected] = n;
    },
    ...(withBindingKey ? { bindingKey: (s: BoundState) => s.selected } : {}),
  };
  const target: ParameterSpec<BoundState> = {
    id: "target",
    label: "Target",
    kind: "enum",
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
    read: (s) => s.selected,
    write: (s, value) => {
      s.selected = value as "a" | "b";
    },
  };
  const registry = new ParameterRegistry(state, { n: spec, target });
  const set = vi.spyOn(registry, "set");
  const control = createControl(spec, registry);
  cleanups.push(control.dispose);
  document.body.append(control.el);
  const slider = control.el.querySelector<HTMLButtonElement>('[role="slider"]')!;
  slider.setPointerCapture = vi.fn();
  const value = control.el.querySelector<HTMLButtonElement>(".labkit-knob-value")!;
  const editor = control.el.querySelector("input")!;
  const pointer = (
    target: EventTarget,
    type: string,
    x = 100,
    shiftKey = false,
    id = 1,
    y = 100,
  ) => {
    const event = new MouseEvent(type, {
      clientX: x,
      clientY: y,
      button: 0,
      shiftKey,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "pointerId", { value: id });
    target.dispatchEvent(event);
  };
  const key = (target: HTMLElement, key: string) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  return { state, registry, set, control, slider, value, editor, pointer, key };
}

describe("numeric knob: binding key", () => {
  it("cancels an unfinished draft when the registry selection changes", () => {
    const { state, registry, set, value, editor, key } = mountBound();
    value.click();
    editor.value = "42";
    registry.set("target", "b", "api");
    expect(editor.hidden).toBe(true);
    expect(state.a).toBe(20);
    expect(state.b).toBe(20);
    set.mockClear();
    key(editor, "Enter");
    expect(state.b).toBe(20);
    expect(set).not.toHaveBeenCalled();
    // The discarded draft is not silently reused for the next edit.
    value.click();
    expect(editor.value).toBe("20");
  });

  it("checks the key before Enter/blur even when selection changes before render", () => {
    const { state, value, editor, key } = mountBound();
    value.click();
    editor.value = "42";
    state.selected = "b";
    key(editor, "Enter");
    expect(state.a).toBe(20);
    expect(state.b).toBe(20);

    state.selected = "a";
    value.click();
    editor.value = "55";
    state.selected = "b";
    editor.blur();
    expect(state.a).toBe(20);
    expect(state.b).toBe(20);
  });

  it("cancels drag on selection change with and without an update, keeping old writes", () => {
    const first = mountBound();
    first.pointer(first.slider, "pointerdown");
    first.pointer(window, "pointermove", 100, false, 1, 76);
    expect(first.state.a).toBe(30);
    first.registry.set("target", "b", "api");
    expect(document.querySelector(".labkit-knob-scale")).toBeNull();
    first.set.mockClear();
    first.pointer(window, "pointermove", 100, false, 1, 52);
    expect(first.state.a).toBe(30);
    expect(first.state.b).toBe(20);
    expect(first.set).not.toHaveBeenCalled();

    const second = mountBound();
    second.pointer(second.slider, "pointerdown");
    second.pointer(window, "pointermove", 100, false, 1, 76);
    expect(second.state.a).toBe(30);
    second.state.selected = "b";
    second.set.mockClear();
    second.pointer(window, "pointermove", 100, false, 1, 52);
    expect(document.querySelector(".labkit-knob-scale")).toBeNull();
    expect(second.state.a).toBe(30);
    expect(second.state.b).toBe(20);
    expect(second.set).not.toHaveBeenCalled();
  });

  it("keeps draft, focus and drag rebasing when the key is unchanged", () => {
    const { state, registry, control, value, editor, key, slider, pointer } = mountBound();
    value.click();
    editor.value = "42";
    registry.set("n", 35, "midi");
    registry.set("n", 40, "api");
    control.update();
    expect(document.activeElement).toBe(editor);
    expect(editor.value).toBe("42");
    key(editor, "Enter");
    expect(state.a).toBe(42);

    pointer(slider, "pointerdown");
    pointer(window, "pointermove", 100, false, 1, 76);
    expect(state.a).toBe(52);
    registry.set("n", 70, "midi");
    pointer(window, "pointermove", 100, false, 1, 52);
    expect(state.a).toBe(80);
  });

  it("leaves the previous behavior when no binding key is declared", () => {
    const { state, value, editor, key } = mountBound(false);
    value.click();
    editor.value = "42";
    state.selected = "b";
    key(editor, "Enter");
    expect(state.a).toBe(20);
    expect(state.b).toBe(42);
  });
});

describe("numeric knob", () => {
  it("quantizes from min, supports any and avoids decimal noise", () => {
    expect(knobValue(0.32, 0.05, 1, 0.1)).toBe(0.35);
    expect(knobValue(0.1 + 0.2, 0, 1, 0.1)).toBe(0.3);
    expect(knobValue(0.123456789, 0, 1, "any")).toBe(0.123456789);
    expect(knobValue(0.12345678901234566, 0, 1, "any")).toBe(0.12345678901234566);
    expect(knobValue(-10, 0.05, 0.98, 0.1)).toBe(0.05);
    expect(knobValue(10, 0.05, 0.98, 0.1)).toBe(0.98);
  });
  it("press does not write; relative vertical drag and Shift remain continuous", () => {
    const { slider, pointer, state, set } = mount();
    pointer(slider, "pointerdown");
    expect(set).not.toHaveBeenCalled();
    expect(document.querySelector(".labkit-knob-scale")).not.toBeNull();
    pointer(window, "pointermove", 100, false, 1, 76); // 24px up
    expect(state.n).toBe(0.6);
    pointer(window, "pointermove", 200, false, 1, 76); // horizontal motion is ignored
    expect(state.n).toBe(0.6);
    pointer(window, "pointermove", 100, true, 1, 76); // stationary Shift does not jump
    expect(state.n).toBe(0.6);
    pointer(window, "pointermove", 100, true, 1, 52); // 24px up, 10× finer
    expect(state.n).toBe(0.61);
    pointer(window, "pointermove", 100, false, 1, 76); // 24px down
    expect(state.n).toBe(0.51);
    expect(set).toHaveBeenLastCalledWith("n", 0.51, "ui");
    pointer(window, "pointerup");
    expect(document.querySelector(".labkit-knob-scale")).toBeNull();
  });
  it("horizontal motion and stationary Shift preserve an off-grid API value without writing", () => {
    const { slider, pointer, state, registry, set } = mount({ step: 0.1 });
    registry.set("n", 0.55, "api");
    set.mockClear();
    pointer(slider, "pointerdown");
    pointer(window, "pointermove", 140, false, 1, 100);
    pointer(window, "pointermove", 140, true, 1, 100);
    expect(state.n).toBe(0.55);
    expect(set).not.toHaveBeenCalled();
    pointer(window, "pointermove", 100, false, 1, 76);
    expect(state.n).toBe(0.7);
    expect(set).toHaveBeenCalledExactlyOnceWith("n", 0.7, "ui");
  });
  it("any-step editor commits the exact JavaScript number without precision rounding", () => {
    const { value, editor, key, state, set } = mount({ step: "any" });
    const exact = 0.12345678901234566;
    value.click();
    editor.value = String(exact);
    key(editor, "Enter");
    expect(state.n).toBe(exact);
    expect(set).toHaveBeenCalledExactlyOnceWith("n", exact, "ui");
  });
  it("clamps without edge dead zones; ignores other pointers; external MIDI rebases drag", () => {
    const { slider, pointer, state, registry } = mount({ step: "any" });
    pointer(slider, "pointerdown");
    pointer(window, "pointermove", 1000, false, 2, 1000);
    expect(state.n).toBe(0.5);
    pointer(window, "pointermove", 100, false, 1, -1000);
    expect(state.n).toBe(1);
    pointer(window, "pointermove", 100, false, 1, -976);
    expect(state.n).toBe(0.9);
    registry.set("n", 0.2, "midi");
    expect(slider.getAttribute("aria-valuenow")).toBe("0.2");
    expect(slider.getAttribute("aria-valuetext")).toBe("20%");
    pointer(window, "pointermove", 100, false, 1, -952);
    expect(state.n).toBe(0.1);
    pointer(window, "pointermove", 100, false, 1, 1000);
    expect(state.n).toBe(0);
  });
  it("render refreshes do not discard sub-step motion", () => {
    const { slider, pointer, state, control } = mount({ step: 0.1 });
    pointer(slider, "pointerdown");
    for (let y = 99; y >= 76; y--) {
      pointer(window, "pointermove", 100, false, 1, y);
      control.update();
    }
    expect(state.n).toBe(0.6);
  });
  it("exposes a vertical scale with max on top, min at bottom and a value marker", () => {
    const { slider, pointer } = mount();
    expect(slider.getAttribute("aria-orientation")).toBe("vertical");
    pointer(slider, "pointerdown");
    const popup = document.querySelector<HTMLElement>(".labkit-knob-scale")!;
    const labels = popup.querySelectorAll(
      ":scope > .labkit-knob-scale-high, :scope > .labkit-knob-scale-low",
    );
    expect([...labels].map((label) => label.textContent)).toEqual(["1", "0"]);
    expect(popup.querySelector(".labkit-knob-scale-track .labkit-knob-scale-thumb")).not.toBeNull();
    expect(popup.style.getPropertyValue("--knob-percent")).toBe("50%");
    expect(Number.parseFloat(popup.style.left)).toBeGreaterThanOrEqual(0);
    expect(Number.parseFloat(popup.style.top)).toBeGreaterThanOrEqual(0);
    expect(
      Number.parseFloat(popup.style.left) + Number.parseFloat(popup.style.width),
    ).toBeLessThanOrEqual(window.innerWidth);
    expect(
      Number.parseFloat(popup.style.top) + Number.parseFloat(popup.style.height),
    ).toBeLessThanOrEqual(window.innerHeight);
  });
  it("raw editor keeps focus/draft across registry updates; Enter commits and Escape cancels", () => {
    const { value, editor, key, state, registry, control } = mount({ step: "any" });
    value.click();
    expect(editor.value).toBe("0.5");
    editor.value = "0.123456";
    registry.set("n", 0.8, "midi");
    control.update();
    expect(document.activeElement).toBe(editor);
    expect(editor.value).toBe("0.123456");
    key(editor, "Enter");
    expect(state.n).toBe(0.123456);
    value.click();
    editor.value = "0.4";
    key(editor, "Escape");
    expect(state.n).toBe(0.123456);
    for (const invalid of ["", "oops", "Infinity", "0.5 Hz"]) {
      value.click();
      editor.value = invalid;
      key(editor, "Enter");
      expect(state.n).toBe(0.123456);
    }
    value.click();
    editor.value = "0.7";
    editor.blur();
    expect(state.n).toBe(0.7);
    value.click();
    editor.value = "invalid";
    editor.blur();
    expect(state.n).toBe(0.7);
  });
  it("keyboard arrows and endpoints work; wheel and double-click do not write", () => {
    const { slider, key, state } = mount();
    key(slider, "ArrowRight");
    expect(state.n).toBe(0.51);
    key(slider, "ArrowUp");
    expect(state.n).toBe(0.52);
    key(slider, "ArrowLeft");
    expect(state.n).toBe(0.51);
    key(slider, "ArrowDown");
    expect(state.n).toBe(0.5);
    key(slider, "Home");
    expect(state.n).toBe(0);
    key(slider, "End");
    expect(state.n).toBe(1);
    slider.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
    slider.dispatchEvent(new MouseEvent("dblclick"));
    expect(state.n).toBe(1);
    const any = mount({ step: "any" });
    any.key(any.slider, "ArrowRight");
    expect(any.state.n).toBe(0.51);
  });
  for (const reason of ["disabled", "hidden", "cancel", "lost", "dispose"] as const) {
    it(`closes and cleans interaction on ${reason}`, () => {
      const { slider, pointer, state, control, value, editor } = mount();
      value.click();
      editor.value = "0.8";
      if (reason === "disabled" || reason === "hidden") {
        state[reason === "disabled" ? "enabled" : "visible"] = false;
        control.update();
        expect(editor.hidden).toBe(true);
        expect(state.n).toBe(0.5);
        state.enabled = state.visible = true;
        control.update();
      } else {
        editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      }
      pointer(slider, "pointerdown");
      if (reason === "disabled") {
        state.enabled = false;
        control.update();
      }
      if (reason === "hidden") {
        state.visible = false;
        control.update();
      }
      if (reason === "cancel") pointer(window, "pointercancel");
      if (reason === "lost") slider.dispatchEvent(new Event("lostpointercapture"));
      if (reason === "dispose") control.dispose();
      expect(document.querySelector(".labkit-knob-scale")).toBeNull();
      pointer(window, "pointermove", 200);
      expect(state.n).toBe(0.5);
    });
  }
});
