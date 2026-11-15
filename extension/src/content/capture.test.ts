// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { type CapturedCredentials } from "@password-manager/shared";
import { CaptureWatcher } from "./capture.js";
import { findCaptureForms } from "./detect.js";

const visible = (el: HTMLElement): boolean => el.getAttribute("data-hidden") === null;

function render(html: string): void {
  document.body.innerHTML = html;
}

function field(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

const REGISTER = `<form id="f">
  <input id="email" type="email" name="email">
  <input id="pw" type="password" name="password" autocomplete="new-password">
  <input id="pw2" type="password" name="confirm_password">
  <button id="go" type="submit">Create account</button>
</form>`;

beforeEach(() => render(""));
afterEach(() => render(""));

describe("capture form detection", () => {
  it("finds a registration form: username, password and confirm", () => {
    render(REGISTER);
    const forms = findCaptureForms(document, visible);
    expect(forms).toHaveLength(1);
    expect(forms[0]).toMatchObject({ kind: "register" });
    expect(forms[0]?.newPassword.id).toBe("pw");
    expect(forms[0]?.confirm?.id).toBe("pw2");
    expect(forms[0]?.username?.id).toBe("email");
  });

  it("finds a change-password form: current, new, confirm", () => {
    render(`<form>
      <input id="u" type="hidden" autocomplete="username" value="alice">
      <input id="cur" type="password" autocomplete="current-password">
      <input id="new" type="password" autocomplete="new-password">
      <input id="rep" type="password" autocomplete="new-password">
    </form>`);
    const forms = findCaptureForms(document, visible);
    expect(forms).toHaveLength(1);
    expect(forms[0]?.kind).toBe("change");
    expect(forms[0]?.newPassword.id).toBe("new");
    expect(forms[0]?.confirm?.id).toBe("rep");
    expect(forms[0]?.username?.id).toBe("u"); // hidden autocomplete="username" is allowed here
  });

  it("finds change-password with only current and new, and a lone new-password field", () => {
    render(`<form><input id="old" name="old_password" type="password">
      <input id="n" name="new_password" type="password"></form>`);
    const a = findCaptureForms(document, visible);
    expect(a[0]).toMatchObject({ kind: "change" });
    expect(a[0]?.newPassword.id).toBe("n");
    expect(a[0]?.confirm).toBeNull();

    render(`<form><input id="n" type="password" autocomplete="new-password"></form>`);
    expect(findCaptureForms(document, visible)[0]?.kind).toBe("change");
  });

  it("ignores ordinary login forms and hidden fields", () => {
    render(
      `<form><input type="text" name="user"><input type="password" autocomplete="current-password"></form>`
    );
    expect(findCaptureForms(document, visible)).toHaveLength(0);

    render(`<form><input data-hidden type="password"><input type="password"></form>`);
    expect(findCaptureForms(document, visible)).toHaveLength(0);
  });

  it("treats separate forms separately, including a login form next to a registration form", () => {
    render(`<form id="login"><input type="text" name="user"><input type="password" autocomplete="current-password"></form>
      ${REGISTER}`);
    const forms = findCaptureForms(document, visible);
    expect(forms).toHaveLength(1);
    expect(forms[0]?.kind).toBe("register");
  });

  it("works for forms without a <form> element", () => {
    render(`<section><input id="e" type="email"><input id="a" type="password"><input id="b" type="password">
      <button id="go">Sign up</button></section>`);
    const forms = findCaptureForms(document, visible);
    expect(forms).toHaveLength(1);
    expect(forms[0]?.container.tagName).toBe("SECTION");
  });
});

describe("CaptureWatcher", () => {
  let captured: CapturedCredentials[];
  let activated: boolean;
  let clock: number;
  let watcher: CaptureWatcher;

  beforeEach(() => {
    captured = [];
    activated = true;
    clock = 10_000;
    watcher = new CaptureWatcher({
      doc: document,
      onCapture: (c) => captured.push(c),
      isUserActivated: () => activated,
      visible,
      requireTrusted: false,
      now: () => clock,
    });
    watcher.start();
  });

  afterEach(() => watcher.stop());

  function fillRegistration(password = "Str0ng-pass", confirm = password): void {
    field("email").value = "  alice@example.com ";
    field("pw").value = password;
    field("pw2").value = confirm;
  }

  function submit(form: Element): void {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }

  it("captures on a submit event", () => {
    render(REGISTER);
    fillRegistration();
    submit(field("f"));
    expect(captured).toEqual([
      { kind: "register", username: "alice@example.com", password: "Str0ng-pass" },
    ]);
  });

  it("captures on Enter in a field and on a click of the submit control, once", () => {
    render(REGISTER);
    fillRegistration();
    field("pw2").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    field("go").click(); // same submission seen again right away
    submit(field("f"));
    expect(captured).toHaveLength(1);

    clock += 5000; // a later retry is a new capture
    field("go").click();
    expect(captured).toHaveLength(2);
  });

  it("captures forms that never fire a submit event (script-driven buttons)", () => {
    render(`<section id="s"><input id="email" type="email"><input id="pw" type="password">
      <input id="pw2" type="password"><button id="go" type="button">Sign up</button></section>`);
    fillRegistration();
    field("go").click();
    expect(captured).toHaveLength(1);

    render(`<section><input id="email" type="email"><input id="pw" type="password">
      <input id="pw2" type="password"><div id="go" role="button">Create account</div></section>`);
    fillRegistration();
    clock += 5000;
    field("go").click();
    expect(captured).toHaveLength(2);
  });

  it("captures a change-password form with the new password only", () => {
    render(`<form id="f"><input id="u" type="hidden" autocomplete="username" value="alice">
      <input id="cur" type="password" autocomplete="current-password" value="old-secret">
      <input id="pw" type="password" autocomplete="new-password" value="new-secret-1">
      <input id="pw2" type="password" autocomplete="new-password" value="new-secret-1">
      <button type="submit">Update</button></form>`);
    submit(field("f"));
    expect(captured).toEqual([{ kind: "change", username: "alice", password: "new-secret-1" }]);
    expect(JSON.stringify(captured)).not.toContain("old-secret");
  });

  it("does nothing when the confirmation does not match or the password is empty", () => {
    render(REGISTER);
    fillRegistration("Str0ng-pass", "different");
    submit(field("f"));
    fillRegistration("", "");
    submit(field("f"));
    expect(captured).toEqual([]);
  });

  it("does nothing before a real user gesture, and for ordinary login forms", () => {
    render(REGISTER);
    fillRegistration();
    activated = false;
    submit(field("f"));
    expect(captured).toEqual([]);

    activated = true;
    render(`<form id="f"><input type="text" name="user" value="alice">
      <input type="password" autocomplete="current-password" value="pw"><button type="submit">Sign in</button></form>`);
    submit(field("f"));
    field("f").querySelector("button")?.click();
    expect(captured).toEqual([]);
  });

  it("ignores a click when the browser would block the submit", () => {
    render(`<form id="f"><input id="email" type="email" required>
      <input id="pw" type="password" autocomplete="new-password"><input id="pw2" type="password">
      <button id="go" type="submit">Create account</button></form>`);
    field("pw").value = "Str0ng-pass";
    field("pw2").value = "Str0ng-pass";
    // email is required but empty, so the form is invalid
    field("go").click();
    expect(captured).toEqual([]);
  });

  it("ignores untrusted events by default", () => {
    watcher.stop();
    const strict = new CaptureWatcher({
      doc: document,
      onCapture: (c) => captured.push(c),
      isUserActivated: () => true,
      visible,
    });
    strict.start();
    render(REGISTER);
    fillRegistration();
    submit(field("f")); // dispatched by script, so isTrusted is false
    // Script-generated Enter key presses are untrusted too.
    field("pw2").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(captured).toEqual([]);
    strict.stop();
  });
});
