import {
  isFillData,
  isFocusData,
  isValidExtensionResponse,
  type FocusResponseData,
} from "@password-manager/shared";
import { FormTracker, formForField, type LoginForm } from "./detect.js";
import { fillLogin } from "./fill.js";
import { SuggestionFrame } from "./frame.js";

/**
 * Autofill content script. It only reports "a login field was focused" and, after an explicit
 * click in the extension-owned suggestion frame, asks the service worker for the chosen login.
 * The service worker decides what matches using the browser-provided sender URL, never
 * anything the page supplies.
 */
function start(): void {
  const tracker = new FormTracker(document);
  tracker.start();

  let userActivated = false;
  let activeForm: LoginForm | null = null;
  let lastHandled: { target: EventTarget | null; at: number } = { target: null, at: 0 };

  const frame = new SuggestionFrame(document, {
    onSelect: (id) => void fill(id),
    onDismiss: () => frame.hide(),
  });

  async function onFieldInteraction(target: EventTarget | null): Promise<void> {
    const form = formForField(tracker.getForms(), target);
    if (!form || !(target instanceof HTMLElement)) return;

    const now = Date.now();
    if (lastHandled.target === target && now - lastHandled.at < 300) return;
    lastHandled = { target, at: now };

    activeForm = form;
    let reply: unknown;
    try {
      reply = await chrome.runtime.sendMessage({ type: "LOGIN_FIELD_FOCUSED" });
    } catch {
      return; // Extension was reloaded or the worker is unreachable.
    }
    if (!isValidExtensionResponse<FocusResponseData>(reply, isFocusData) || !reply.ok) return;
    if (reply.data.state === "ineligible") {
      frame.hide();
      return;
    }
    // Locked or empty: still show the frame so the user knows why nothing is offered.
    try {
      await frame.show(target, reply.data.state, reply.data.suggestions);
    } catch {
      frame.hide();
    }
  }

  async function fill(id: string): Promise<void> {
    const form = activeForm;
    if (!form || !frame.wasOffered(id) || !form.password.isConnected) return;
    let reply: unknown;
    try {
      reply = await chrome.runtime.sendMessage({ type: "FILL_REQUEST", payload: { id } });
    } catch {
      frame.hide();
      return;
    }
    frame.hide();
    if (!isValidExtensionResponse(reply, isFillData) || !reply.ok) return;
    fillLogin(form, reply.data);
  }

  // A suggestion only ever appears after the user acts on a field. Page-load autofocus is
  // ignored until a trusted keypress or click has happened.
  const markActivated = (event: Event): void => {
    if (event.isTrusted) userActivated = true;
  };
  document.addEventListener("keydown", markActivated, true);
  document.addEventListener("pointerdown", markActivated, true);

  document.addEventListener(
    "focusin",
    (event) => {
      if (event.isTrusted && userActivated) void onFieldInteraction(event.target);
    },
    true
  );

  document.addEventListener(
    "click",
    (event) => {
      if (event.isTrusted) void onFieldInteraction(event.target);
    },
    true
  );

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!event.isTrusted || frame.owns(event.target)) return;
      if (!formForField(tracker.getForms(), event.target)) frame.hide();
    },
    true
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.isTrusted && event.key === "Escape") frame.hide();
    },
    true
  );

  window.addEventListener("scroll", () => frame.reposition(), { passive: true, capture: true });
  window.addEventListener("resize", () => frame.reposition(), { passive: true });
}

// Top frame only. Never run in, or fill into, cross-origin iframes.
if (window.top === window && typeof chrome !== "undefined" && chrome.runtime?.id) {
  start();
}
