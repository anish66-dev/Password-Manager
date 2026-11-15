// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FormTracker, findLoginForms, findUsernameFor, formForField, isVisible } from "./detect.js";

/** jsdom has no layout, so tests decide visibility from simple markers. */
const visible = (el: HTMLElement): boolean =>
  !el.closest("[data-hidden]") && el.getAttribute("data-hidden") === null;

function render(html: string): void {
  document.body.innerHTML = html;
}

beforeEach(() => render(""));
afterEach(() => render(""));

describe("login form detection", () => {
  it("finds a plain username and password form", () => {
    render(`<form>
      <input id="u" name="username" type="text">
      <input id="p" name="password" type="password">
    </form>`);
    const forms = findLoginForms(document, visible);
    expect(forms).toHaveLength(1);
    expect(forms[0]?.username?.id).toBe("u");
    expect(forms[0]?.password.id).toBe("p");
  });

  it("finds an email field by type, autocomplete, name and id", () => {
    for (const field of [
      '<input id="x" type="email">',
      '<input id="x" type="text" autocomplete="username">',
      '<input id="x" type="text" name="user_login">',
      '<input id="x" type="text" id="x" placeholder="Email address">',
    ]) {
      render(`<form><input type="hidden" name="csrf"> ${field}<input type="password"></form>`);
      expect(findLoginForms(document, visible)[0]?.username?.id, field).toBe("x");
    }
  });

  it("picks the best-scored field, then the closest one", () => {
    render(`<form>
      <input id="search" type="text" name="search">
      <input id="email" type="email" name="email">
      <input id="other" type="text" name="nickname">
      <input type="password">
    </form>`);
    expect(findLoginForms(document, visible)[0]?.username?.id).toBe("email");

    render(
      `<form><input id="a" type="text"><input id="b" type="text"><input type="password"></form>`
    );
    expect(findLoginForms(document, visible)[0]?.username?.id).toBe("b");
  });

  it("works without a <form> element, looking only a short way back", () => {
    render(`<div><input id="u" type="text" name="user"><input type="password"></div>`);
    expect(findLoginForms(document, visible)[0]?.username?.id).toBe("u");

    render(`<input id="far" type="text" name="user"><p></p>
      <input type="text"><input type="text"><input type="text"><input type="password">`);
    expect(findLoginForms(document, visible)[0]?.username?.id).not.toBe("far");
  });

  it("returns a password-only form with no username", () => {
    render(`<form><input type="password"></form>`);
    const forms = findLoginForms(document, visible);
    expect(forms).toHaveLength(1);
    expect(forms[0]?.username).toBeNull();
  });

  it("ignores hidden, disabled and read-only fields", () => {
    render(`<form>
      <input data-hidden type="text" name="username" id="honeypot">
      <input id="real" type="text" name="email">
      <input data-hidden type="password" id="hiddenpw">
    </form>
    <form><input type="password" disabled><input type="password" readonly></form>`);
    expect(findLoginForms(document, visible)).toHaveLength(0);

    render(`<form>
      <input data-hidden type="text" name="username" id="honeypot">
      <input id="real" type="text" name="email">
      <input type="password">
    </form>`);
    expect(findLoginForms(document, visible)[0]?.username?.id).toBe("real");
  });

  it("skips new-password fields (registration and change flows)", () => {
    render(`<form><input type="text"><input type="password" autocomplete="new-password"></form>`);
    expect(findLoginForms(document, visible)).toHaveLength(0);
  });

  it("finds each form on a page with several", () => {
    render(`<form id="a"><input type="text" id="u1"><input type="password"></form>
      <form id="b"><input type="text" id="u2"><input type="password"></form>`);
    const forms = findLoginForms(document, visible);
    expect(forms.map((f) => f.username?.id)).toEqual(["u1", "u2"]);
  });

  it("maps a focused field back to its form", () => {
    render(`<form><input id="u" type="text" name="user"><input id="p" type="password">
      <input id="x" type="text"></form>`);
    const forms = findLoginForms(document, visible);
    expect(formForField(forms, document.getElementById("u"))).toBe(forms[0]);
    expect(formForField(forms, document.getElementById("p"))).toBe(forms[0]);
    expect(formForField(forms, document.getElementById("x"))).toBeNull();
    expect(formForField(forms, null)).toBeNull();
  });

  it("findUsernameFor returns null when nothing precedes the password", () => {
    render(`<form><input id="p" type="password"><input type="text" name="user"></form>`);
    expect(findUsernameFor(document.getElementById("p") as HTMLInputElement, visible)).toBeNull();
  });
});

describe("visibility check", () => {
  function stubRect(el: HTMLElement, rect: Partial<DOMRect>): void {
    el.getBoundingClientRect = () =>
      ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, ...rect }) as DOMRect;
  }

  function input(): HTMLInputElement {
    const el = document.createElement("input");
    document.body.appendChild(el);
    return el;
  }

  it("accepts a normally sized on-screen field", () => {
    const el = input();
    stubRect(el, { width: 200, height: 30, left: 10, top: 10, right: 210, bottom: 40 });
    expect(isVisible(el)).toBe(true);
  });

  it("rejects zero-size, tiny and off-screen fields", () => {
    const zero = input();
    stubRect(zero, {});
    const tiny = input();
    stubRect(tiny, { width: 1, height: 1, right: 1, bottom: 1 });
    const off = input();
    stubRect(off, { width: 200, height: 30, left: -9999, right: -9799, top: 0, bottom: 30 });
    expect(isVisible(zero)).toBe(false);
    expect(isVisible(tiny)).toBe(false);
    expect(isVisible(off)).toBe(false);
  });

  it("rejects hidden attributes and detached elements", () => {
    const hidden = input();
    hidden.hidden = true;
    stubRect(hidden, { width: 200, height: 30, right: 200, bottom: 30 });
    const ariaHidden = input();
    ariaHidden.setAttribute("aria-hidden", "true");
    stubRect(ariaHidden, { width: 200, height: 30, right: 200, bottom: 30 });
    const detached = document.createElement("input");
    expect(isVisible(hidden)).toBe(false);
    expect(isVisible(ariaHidden)).toBe(false);
    expect(isVisible(detached)).toBe(false);
  });
});

describe("FormTracker", () => {
  it("picks up forms added after load", async () => {
    const tracker = new FormTracker(document, visible);
    tracker.start();
    expect(tracker.getForms()).toHaveLength(0);

    const form = document.createElement("form");
    form.innerHTML = '<input type="text" name="user" id="late"><input type="password">';
    document.body.appendChild(form);

    // Synchronous read sees the change even before the debounced rescan runs.
    expect(tracker.getForms()).toHaveLength(1);
    expect(tracker.getForms()[0]?.username?.id).toBe("late");

    form.remove();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(tracker.getForms()).toHaveLength(0);
    tracker.stop();
  });
});
