// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { fillLogin, setNativeValue } from "./fill.js";

beforeEach(() => {
  document.body.innerHTML = '<form><input id="u" type="text"><input id="p" type="password"></form>';
});

function field(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

describe("fill", () => {
  it("sets the value and dispatches bubbling input and change events", () => {
    const events: string[] = [];
    document.addEventListener("input", (e) => events.push(`input:${(e.target as Element).id}`));
    document.addEventListener("change", (e) => events.push(`change:${(e.target as Element).id}`));
    setNativeValue(field("u"), "alice");
    expect(field("u").value).toBe("alice");
    expect(events).toEqual(["input:u", "change:u"]);
  });

  it("works for React-style inputs whose own value property is shadowed", () => {
    const input = field("p");
    let tracked = "";
    // React installs an instance-level accessor to track the last known value.
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () =>
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.get?.call(input),
      set: (v: string) => {
        tracked = v;
      },
    });
    let seenByListener = "";
    input.addEventListener("input", () => {
      seenByListener = input.value;
    });

    setNativeValue(input, "s3cret");
    expect(tracked).toBe(""); // the shadowing setter was bypassed, as React's tracker needs
    expect(seenByListener).toBe("s3cret");
  });

  it("fills both fields, skipping a missing or empty username", () => {
    fillLogin(
      { username: field("u"), password: field("p") },
      { username: "alice", password: "pw" }
    );
    expect(field("u").value).toBe("alice");
    expect(field("p").value).toBe("pw");

    field("u").value = "keep";
    fillLogin({ username: field("u"), password: field("p") }, { username: "", password: "pw2" });
    expect(field("u").value).toBe("keep");
    expect(field("p").value).toBe("pw2");

    fillLogin({ username: null, password: field("p") }, { username: "x", password: "pw3" });
    expect(field("p").value).toBe("pw3");
  });
});
