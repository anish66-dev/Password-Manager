import "./suggestions.css";
import {
  isDoneData,
  isValidExtensionResponse,
  type CaptureDecision,
  type CapturePrompt,
  type FocusState,
} from "@password-manager/shared";
import { type FromFrame, isFrameInit, isToFrame } from "../content/frame-protocol.js";
import { type Suggestion } from "@password-manager/shared";

/**
 * Extension-owned page rendered inside an iframe on web pages. It trusts only a MessagePort
 * that was authenticated with the service worker (nonce check), and it never uses innerHTML.
 */
const card = document.getElementById("card") as HTMLElement;
let port: MessagePort | null = null;

function send(message: FromFrame): void {
  port?.postMessage(message);
}

function textElement(tag: string, className: string, text: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}

function render(state: FocusState, suggestions: Suggestion[]): void {
  card.replaceChildren();

  if (state === "uninitialized") {
    card.append(textElement("p", "note", "No vault yet. Open the extension to create one."));
  } else if (state === "locked") {
    card.append(
      textElement("p", "title", "Vault locked"),
      textElement("p", "note", "Open the extension to unlock it.")
    );
  } else if (suggestions.length === 0) {
    card.append(textElement("p", "note", "No saved logins for this site."));
  } else {
    for (const suggestion of suggestions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "item";
      button.append(
        textElement("span", "user", suggestion.username || "(no username)"),
        textElement("span", "domain", suggestion.displayDomain)
      );
      button.addEventListener("click", (event) => {
        // Synthetic clicks (for example from page script) are ignored.
        if (!event.isTrusted) return;
        send({ type: "select", id: suggestion.id });
      });
      card.append(button);
    }
  }

  // Report the content height once layout is done. Timers, not requestAnimationFrame: a
  // hidden cross-origin iframe may not get animation frames.
  const reportSize = (): void => send({ type: "size", height: Math.ceil(card.scrollHeight) + 2 });
  setTimeout(reportSize, 0);
  setTimeout(reportSize, 60);
}

function actionButton(label: string, className: string, decision: CaptureDecision): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", (event) => {
    // Synthetic clicks (for example from page script) never count as a decision.
    if (!event.isTrusted) return;
    send({ type: "decision", decision });
  });
  return button;
}

/** The save/update prompt. The password is only ever shown as dots. */
function renderPrompt(prompt: CapturePrompt): void {
  card.replaceChildren();
  const title =
    prompt.mode === "update"
      ? "Update password?"
      : prompt.mode === "unlock"
        ? "Unlock to save"
        : "Save password?";

  const details = document.createElement("div");
  details.className = "details";
  details.append(
    textElement("div", "site", prompt.site),
    textElement("div", "user", prompt.username || "(no username)"),
    textElement("div", "dots", "\u2022".repeat(Math.min(Math.max(prompt.passwordLength, 1), 16)))
  );

  const actions = document.createElement("div");
  actions.className = "actions";
  if (prompt.mode === "unlock") {
    actions.append(actionButton("Not now", "secondary", "dismiss"));
  } else {
    actions.append(
      actionButton(prompt.mode === "update" ? "Update" : "Save", "primary", "accept"),
      actionButton("Never", "secondary", "never"),
      actionButton("Not now", "ghost", "dismiss")
    );
  }

  card.append(textElement("p", "title", title), details);
  if (prompt.mode === "unlock") {
    card.append(
      textElement(
        "p",
        "note",
        "Open the extension and unlock your vault. This stays available for about a minute."
      )
    );
  }
  card.append(actions);

  const reportSize = (): void => send({ type: "size", height: Math.ceil(card.scrollHeight) + 2 });
  setTimeout(reportSize, 0);
  setTimeout(reportSize, 60);
}

document.addEventListener("keydown", (event) => {
  if (event.isTrusted && event.key === "Escape") send({ type: "dismiss" });
});

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (port) return; // First authenticated init wins; later ones are ignored.
  if (event.source !== window.parent || !isFrameInit(event.data) || event.ports.length !== 1) {
    return;
  }
  const candidate = event.ports[0];
  if (!candidate) return;
  const nonce = event.data.nonce;

  // A page can post to this window too, but it cannot know the nonce that the content script
  // registered with the service worker, so a forged port is rejected here.
  void chrome.runtime.sendMessage({ type: "FRAME_CLAIM", payload: { nonce } }).then(
    (reply: unknown) => {
      if (port || !isValidExtensionResponse(reply, isDoneData) || !reply.ok) return;
      port = candidate;
      port.onmessage = (message: MessageEvent<unknown>) => {
        const data = message.data;
        if (!isToFrame(data)) return;
        if (data.type === "prompt") renderPrompt(data.prompt);
        else render(data.state, data.suggestions);
      };
      send({ type: "ready" });
    },
    () => undefined
  );
});
