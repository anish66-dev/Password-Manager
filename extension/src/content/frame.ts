import {
  type CaptureDecision,
  type CapturePrompt,
  type FocusState,
  type Suggestion,
  isDoneData,
  isValidExtensionResponse,
} from "@password-manager/shared";
import { type FrameInit, type ToFrame, isFromFrame } from "./frame-protocol.js";

export interface FrameHandlers {
  onSelect(id: string): void;
  onDismiss(): void;
  onDecision(decision: CaptureDecision): void;
}

const FRAME_WIDTH = 280;
const PROMPT_WIDTH = 320;
const PROMPT_MARGIN = 12;
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
  private mode: "suggest" | "prompt" = "suggest";

  constructor(
    private readonly doc: Document,
    private readonly handlers: FrameHandlers
  ) {}

  /** True if the node is our iframe element. */
  owns(node: EventTarget | null): boolean {
    return node !== null && node === this.iframe;
  }

  /** True while a save/update prompt is on screen. It takes priority over suggestions. */
  isPromptShowing(): boolean {
    return this.mode === "prompt";
  }

  /** Shows a save/update prompt in the top-right corner of the page. */
  async showPrompt(prompt: CapturePrompt): Promise<void> {
    const port = await this.ensure();
    this.mode = "prompt";
    this.anchor = null;
    this.offered = new Set();
    this.setStyle("width", `${PROMPT_WIDTH}px`);
    const message: ToFrame = { type: "prompt", prompt };
    port.postMessage(message);
  }

  async show(anchor: HTMLElement, state: FocusState, suggestions: Suggestion[]): Promise<void> {
    if (this.mode === "prompt") return;
    const port = await this.ensure();
    if (this.isPromptShowing()) return; // A prompt appeared while the frame was loading.
    this.setStyle("width", `${FRAME_WIDTH}px`);
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
    this.mode = "suggest";
    this.visible = false;
    this.anchor = null;
    this.offered = new Set();
    this.applyHidden();
  }

  /**
   * Style helpers. The iframe's styles all carry !important and the element is never
   * display:none: a display:none iframe has no layout (so its content height cannot be
   * measured) and an `all: initial` rule would otherwise override plain left/top values,
   * which left the frame at its static position at the bottom of the page.
   */
  private setStyle(property: string, value: string): void {
    this.iframe?.style.setProperty(property, value, "important");
  }

  private applyHidden(): void {
    this.setStyle("visibility", "hidden");
    this.setStyle("pointer-events", "none");
    this.setStyle("height", "0px");
  }

  private applyShown(height: number): void {
    this.setStyle("height", `${height}px`);
    this.setStyle("visibility", "visible");
    this.setStyle("pointer-events", "auto");
  }

  reposition(): void {
    if (this.iframe && this.mode === "prompt" && this.visible) {
      const view = this.doc.defaultView;
      if (!view) return;
      const left = Math.max(PROMPT_MARGIN, view.innerWidth - PROMPT_WIDTH - PROMPT_MARGIN);
      this.setStyle("left", `${left}px`);
      this.setStyle("top", `${PROMPT_MARGIN}px`);
      return;
    }
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
    this.setStyle("left", `${left}px`);
    this.setStyle("top", `${top}px`);
  }

  destroy(): void {
    this.port?.close();
    this.port = null;
    this.pending = null;
    this.iframe?.remove();
    this.iframe = null;
    this.visible = false;
    this.mode = "suggest";
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
        "left: 0",
        "top: 0",
        "visibility: hidden",
        "pointer-events: none",
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
            if (data.height > 0 && (this.anchor || this.mode === "prompt")) {
              this.visible = true;
              this.applyShown(data.height);
              this.reposition();
            } else {
              this.visible = false;
              this.applyHidden();
            }
            break;
          case "select":
            this.handlers.onSelect(data.id);
            break;
          case "dismiss":
            this.handlers.onDismiss();
            break;
          case "decision":
            this.handlers.onDecision(data.decision);
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
