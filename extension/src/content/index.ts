import {
  isCapturePromptData,
  isDoneData,
  isFillData,
  isFocusData,
  isValidExtensionResponse,
  type CaptureDecision,
  type CapturedCredentials,
  type FocusResponseData,
} from "@password-manager/shared";
import { CaptureWatcher } from "./capture.js";
import { FormTracker, formForField, type LoginForm } from "./detect.js";
import { fillLogin } from "./fill.js";
import { SuggestionFrame } from "./frame.js";

/**
 * Autofill and save-prompt content script.
 *  - Autofill: it only reports "a login field was focused" and, after an explicit click in the
 *    extension-owned frame, asks the service worker for the chosen login.
 *  - Save prompts: it reports credentials the user submitted on a registration or
 *    password-change form. The service worker keeps them (memory only) and the prompt only ever
 *    receives the password length, never the password.
 * The service worker decides everything using the browser-provided sender URL, never anything
 * the page supplies.
 */
function start(): void {
  const tracker = new FormTracker(document);
  tracker.start();

  let userActivated = false;
  let activeForm: LoginForm | null = null;
  let lastHandled: { target: EventTarget | null; at: number } = { target: null, at: 0 };

  const frame = new SuggestionFrame(document, {
    onSelect: (id) => void fill(id),
    onDismiss: () => {
      if (frame.isPromptShowing()) void decide("dismiss");
      else frame.hide();
    },
    onDecision: (decision) => void decide(decision),
  });

  // ----- Save and update prompts -----

  /** Shows the prompt in a reply from the service worker, or clears a stale one. */
  async function present(reply: unknown): Promise<void> {
    if (!isValidExtensionResponse(reply, isCapturePromptData) || !reply.ok) return;
    const prompt = reply.data.prompt;
    if (!prompt) {
      if (frame.isPromptShowing()) frame.hide();
      return;
    }
    try {
      await frame.showPrompt(prompt);
    } catch {
      frame.hide();
    }
  }

  async function checkPending(): Promise<void> {
    try {
      await present(await chrome.runtime.sendMessage({ type: "PENDING_CAPTURE_GET" }));
    } catch {
      // Extension reloaded or worker unreachable.
    }
  }

  async function onCapture(credentials: CapturedCredentials): Promise<void> {
    try {
      await present(
        await chrome.runtime.sendMessage({ type: "CREDENTIAL_CAPTURED", payload: credentials })
      );
    } catch {
      // Nothing was stored anywhere; the user simply gets no prompt.
    }
  }

  async function decide(decision: CaptureDecision): Promise<void> {
    let reply: unknown;
    try {
      reply = await chrome.runtime.sendMessage({
        type: "CAPTURE_DECISION",
        payload: { decision },
      });
    } catch {
      frame.hide();
      return;
    }
    if (isValidExtensionResponse(reply, isDoneData) && reply.ok) {
      frame.hide();
      return;
    }
    // Refused, for example because the vault is locked: show what is still possible.
    await checkPending();
  }

  // ----- Autofill suggestions -----

  async function onFieldInteraction(target: EventTarget | null): Promise<void> {
    if (frame.isPromptShowing()) return; // A save prompt takes priority.
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

  // A suggestion or capture only ever happens after the user acts on the page. Page-load
  // autofocus and script-generated events are ignored until a trusted keypress or click.
  const markActivated = (event: Event): void => {
    if (event.isTrusted) userActivated = true;
  };
  document.addEventListener("keydown", markActivated, true);
  document.addEventListener("pointerdown", markActivated, true);

  const watcher = new CaptureWatcher({
    doc: document,
    onCapture: (credentials) => void onCapture(credentials),
    isUserActivated: () => userActivated,
  });
  watcher.start();

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
      if (!event.isTrusted || frame.isPromptShowing() || frame.owns(event.target)) return;
      if (!formForField(tracker.getForms(), event.target)) frame.hide();
    },
    true
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.isTrusted && event.key === "Escape" && !frame.isPromptShowing()) frame.hide();
    },
    true
  );

  window.addEventListener("scroll", () => frame.reposition(), { passive: true, capture: true });
  window.addEventListener("resize", () => frame.reposition(), { passive: true });

  // Messages from the extension itself (never from the page): a waiting prompt can be shown,
  // for example right after the user unlocks the vault.
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || sender.tab !== undefined) return;
    if (
      typeof message === "object" &&
      message !== null &&
      (message as { type?: unknown }).type === "PENDING_CAPTURE_AVAILABLE"
    ) {
      void checkPending();
    }
  });

  // A prompt can appear on the page after a redirect.
  void checkPending();
}

// Top frame only. Never run in, or fill into, cross-origin iframes.
if (window.top === window && typeof chrome !== "undefined" && chrome.runtime?.id) {
  start();
}
