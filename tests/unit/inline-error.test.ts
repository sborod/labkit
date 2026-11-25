// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { createInlineError } from "../../src/index.ts";

describe("createInlineError", () => {
  it("starts as an empty hidden alert span and uses the given document", () => {
    const doc = document.implementation.createHTMLDocument("inline-error");
    const error = createInlineError(doc);

    expect(error.el.tagName).toBe("SPAN");
    expect(error.el.ownerDocument).toBe(doc);
    expect(error.el.getAttribute("role")).toBe("alert");
    expect(error.el.hidden).toBe(true);
    expect(error.el.textContent).toBe("");
    expect(error.el.classList.contains("labkit-inline-error")).toBe(true);
  });

  it("shows a message and clears or hides on null/empty input", () => {
    const error = createInlineError(document);

    error.set("Введите целое число");
    expect(error.el.hidden).toBe(false);
    expect(error.el.textContent).toBe("Введите целое число");

    error.set(null);
    expect(error.el.hidden).toBe(true);
    expect(error.el.textContent).toBe("");

    error.set("Снова ошибка");
    error.set("");
    expect(error.el.hidden).toBe(true);
    expect(error.el.textContent).toBe("");
  });

  it("writes markup as plain text instead of HTML", () => {
    const error = createInlineError(document);

    error.set("<b>не HTML</b><img src=x onerror=alert(1)>");

    expect(error.el.textContent).toBe("<b>не HTML</b><img src=x onerror=alert(1)>");
    expect(error.el.children).toHaveLength(0);
    expect(error.el.querySelector("b, img")).toBeNull();
  });
});
