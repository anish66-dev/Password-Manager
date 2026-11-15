import {
  type FocusState,
  type Suggestion,
  isDoneData,
  isValidExtensionResponse,
} from "@password-manager/shared";
import { type FrameInit, type ToFrame, isFromFrame } from "./frame-protocol.js";

export interface FrameHandlers {
  onSelect(id: string): void;
  onDismiss(): void;
}

const FRAME_WIDTH = 280;
const READY_TIMEOUT_MS = 3000;

/**
 * Owns the extension-owned suggestion iframe. The page can see that the iframe exists, but
 * not its contents (different origin), and it cannot talk to it: the iframe only listens to a
 * MessageChannel port that this class creates and authenticates with the service worker.
 */
export class SuggestionFrame {
  private iframe: HTMLIFrameElement | null = null;
  private port: MessagePort | null = null;
  private pending: Promise<MessagePort> | null = null;
  private anchor: HTMLElement | null = null;
  private offered = new Set<string>();
  private visible = false;

  constructor(
    private readonly doc: Document,
    private readonly handlers: FrameHandlers
  ) {}

  /** True if the node is our iframe element. */
  owns(node: EventTarget | null): boolean {
    return node !== null && node === this.iframe;
  }

  async show(anchor: HTMLElement, state: FocusState, suggestions: Suggestion[]): Promise<void> {
    const port = await this.ensure();
    this.anchor = anchor;
    this.offered = new Set(suggestions.map((s) => s.id));
    const message: ToFrame = { type: "render", state, suggestions };
    port.postMessage(message);
  }

  /** Only ids that were actually offered can be selected. */
  wasOffered(id: string): boolean {
    return this.offered.has(id);
  }

  hide(): void {
    this.visible = false;
    this.anchor = null;
    this.offered = new Set();
    if (this.iframe) this.iframe.style.display = "none";
  }

  reposition(): void {
    if (!this.iframe || !this.anchor || !this.visible) return;
    if (!this.anchor.isConnected) {
      this.hide();
      return;
    }
    const view = this.doc.defaultView;
    if (!view) return;
    const rect = this.anchor.getBoundingClientRect();
    const height = this.iframe.offsetHeight;
    const left = Math.max(4, Math.min(rect.left, view.innerWidth - FRAME_WIDTH - 4));
    let top = rect.bottom + 4;
    if (top + height > view.innerHeight && rect.top - 4 - height >= 0) {
      top = rect.top - 4 - height;
    }
    this.iframe.style.left = `${left}px`;
    this.iframe.style.top = `${top}px`;
  }

  destroy(): void {
    this.port?.close();
    this.port = null;
    this.pending = null;
    this.iframe?.remove();
    this.iframe = null;
    this.visible = false;
  }

  private ensure(): Promise<MessagePort> {
    if (this.port) return Promise.resolve(this.port);
    if (!this.pending) {
      this.pending = this.createFrame().catch((err) => {
        this.destroy();
        throw err;
      });
    }
    return this.pending;
  }

  private async createFrame(): Promise<MessagePort> {
    // The nonce is known only to this content script, the service worker and (via the port
    // handshake) the iframe. A page that forges a port cannot supply a valid one.
    const nonce = crypto.randomUUID();
    const registered: unknown = await chrome.runtime.sendMessage({
      type: "FRAME_REGISTER",
      payload: { nonce },
    });
    if (!isValidExtensionResponse(registered, isDoneData) || !registered.ok) {
      throw new Error("Frame registration failed.");
    }

    const src = chrome.runtime.getURL("suggestions.html");
    const iframe = this.doc.createElement("iframe");
    iframe.src = src;
    iframe.setAttribute("tabindex", "-1");
    iframe.setAttribute("aria-label", "Password manager suggestions");
    iframe.style.cssText =
      [
        "all: initial",
        "position: fixed",
        "z-index: 2147483647",
        "border: 0",
        "display: none",
        `width: ${FRAME_WIDTH}px`,
        "height: 0",
        "color-scheme: light",
        "background: transparent",
      ].join(" !important; ") + " !important";
    this.iframe = iframe;
    this.doc.documentElement.appendChild(iframe);

    await new Promise<void>((resolve, reject) => {
      iframe.addEventListener("load", () => resolve(), { once: true });
      iframe.addEventListener("error", () => reject(new Error("Frame failed to load.")), {
        once: true,
      });
    });

    const channel = new MessageChannel();
    const port = channel.port1;
    const target = iframe.contentWindow;
    if (!target) throw new Error("Frame is unavailable.");

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Frame did not respond.")), READY_TIMEOUT_MS);
      port.onmessage = (event: MessageEvent<unknown>) => {
        const data = event.data;
        if (!isFromFrame(data)) return;
        switch (data.type) {
          case "ready":
            clearTimeout(timer);
            resolve();
            break;
          case "size":
            iframe.style.setProperty("height", `${data.height}px`, "important");
            iframe.style.setProperty("display", data.height > 0 ? "block" : "none", "important");
            this.visible = data.height > 0;
            this.reposition();
            break;
          case "select":
            this.handlers.onSelect(data.id);
            break;
          case "dismiss":
            this.handlers.onDismiss();
            break;
        }
      };
    });

    const init: FrameInit = { type: "pm-init", nonce };
    // Target origin restricts delivery to our own extension page.
    target.postMessage(init, new URL(src).origin, [channel.port2]);
    await ready;

    this.port = port;
    return port;
  }
}
