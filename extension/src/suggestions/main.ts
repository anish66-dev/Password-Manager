import "./suggestions.css";
import { isDoneData, isValidExtensionResponse, type FocusState } from "@password-manager/shared";
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

  // Report the content height after layout so the host can size the iframe.
  requestAnimationFrame(() => send({ type: "size", height: Math.ceil(card.scrollHeight) + 2 }));
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
        if (isToFrame(message.data)) render(message.data.state, message.data.suggestions);
      };
      send({ type: "ready" });
    },
    () => undefined
  );
});
