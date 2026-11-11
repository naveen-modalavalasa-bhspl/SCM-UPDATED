import { describe, expect, it, beforeAll } from "vitest";
import { installTruncationTitles } from "@/shared/truncationTitles";

/** jsdom does no layout, so each case states the box sizes it wants. */
function box(el: HTMLElement, scrollWidth: number, clientWidth: number) {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: scrollWidth });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: clientWidth });
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: 20 });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 20 });
}

function span(text: string) {
  const el = document.createElement("span");
  el.style.textOverflow = "ellipsis";
  el.style.overflow = "hidden";
  el.textContent = text;
  document.body.appendChild(el);
  return el;
}

const hover = (el: Element) =>
  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));

describe("installTruncationTitles", () => {
  beforeAll(() => installTruncationTitles());

  it("puts the full text on a cut-short item name", () => {
    const el = span("IT-3003 — 27-inch Full HD LED Monitor");
    box(el, 400, 120);
    hover(el);
    expect(el.getAttribute("title")).toBe("IT-3003 — 27-inch Full HD LED Monitor");
  });

  it("leaves text that fits alone", () => {
    const el = span("IT-3001");
    box(el, 60, 120);
    hover(el);
    expect(el.hasAttribute("title")).toBe(false);
  });

  it("never overwrites a title somebody wrote", () => {
    const el = span("Long long long name");
    el.setAttribute("title", "Written on purpose");
    box(el, 400, 120);
    hover(el);
    expect(el.getAttribute("title")).toBe("Written on purpose");
  });

  it("drops its own title once the text fits again", () => {
    const el = span("A long item name");
    box(el, 400, 120);
    hover(el);
    expect(el.getAttribute("title")).toBe("A long item name");
    box(el, 100, 120);
    hover(el);
    expect(el.hasAttribute("title")).toBe(false);
  });

  it("reads an input's value", () => {
    const input = document.createElement("input");
    input.value = "LAB-2003 — Microscope Slides, pack of 50";
    document.body.appendChild(input);
    box(input, 400, 120);
    hover(input);
    expect(input.getAttribute("title")).toBe("LAB-2003 — Microscope Slides, pack of 50");
  });
});
