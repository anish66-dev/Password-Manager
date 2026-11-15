import { type CapturedCredentials } from "@password-manager/shared";
import { type CaptureForm, type VisibilityCheck, findCaptureForms, isVisible } from "./detect.js";

export interface CaptureWatcherOptions {
  doc: Document;
  /** Called with captured credentials. Must send them to the service worker, nowhere else. */
  onCapture: (credentials: CapturedCredentials) => void;
  /** Whether a real user gesture has happened on this page. */
  isUserActivated: () => boolean;
  visible?: VisibilityCheck;
  /** Real browsers only deliver trusted events. Tests turn this off. */
  requireTrusted?: boolean;
  now?: () => number;
}

const DEDUPE_MS = 1500;
const SUBMIT_TEXT =
  /sign\s?up|register|create|join|continue|next|submit|save|update|change|reset|confirm/i;

/**
 * Watches registration and password-change forms and reports what the user submitted.
 * It captures on a real submit event, on Enter inside the form, and on a click of the submit
 * control (which also covers forms that never fire a submit event). Nothing leaves the page
 * except the single message to the service worker, and only after a real user gesture.
 */
export class CaptureWatcher {
  private readonly doc: Document;
  private readonly visible: VisibilityCheck;
  private readonly requireTrusted: boolean;
  private readonly now: () => number;
  private last: { container: Element; at: number } | null = null;
  private listening = false;

  constructor(private readonly options: CaptureWatcherOptions) {
    this.doc = options.doc;
    this.visible = options.visible ?? isVisible;
    this.requireTrusted = options.requireTrusted ?? true;
    this.now = options.now ?? (() => Date.now());
  }

  start(): void {
    if (this.listening) return;
    this.listening = true;
    this.doc.addEventListener("submit", this.onSubmit, true);
    this.doc.addEventListener("keydown", this.onKeydown, true);
    this.doc.addEventListener("click", this.onClick, true);
  }

  stop(): void {
    this.listening = false;
    this.doc.removeEventListener("submit", this.onSubmit, true);
    this.doc.removeEventListener("keydown", this.onKeydown, true);
    this.doc.removeEventListener("click", this.onClick, true);
  }

  private trusted(event: Event): boolean {
    return !this.requireTrusted || event.isTrusted;
  }

  private readonly onSubmit = (event: Event): void => {
    if (!this.trusted(event) || !(event.target instanceof Element)) return;
    this.handle(event.target, false);
  };

  private readonly onKeydown = (event: Event): void => {
    const key = event as KeyboardEvent;
    if (!this.trusted(event) || key.key !== "Enter" || key.isComposing) return;
    if (!(event.target instanceof HTMLInputElement)) return;
    this.handle(event.target, true);
  };

  private readonly onClick = (event: Event): void => {
    if (!this.trusted(event) || !(event.target instanceof Element)) return;
    const control = event.target.closest(
      "button, input[type='submit'], input[type='button'], [role='button']"
    );
    if (!control || !this.isSubmitControl(control)) return;
    this.handle(control, true);
  };

  private isSubmitControl(control: Element): boolean {
    if (control instanceof HTMLButtonElement) {
      if (control.type === "submit") return true;
      return SUBMIT_TEXT.test(control.textContent ?? "");
    }
    if (control instanceof HTMLInputElement) {
      return control.type === "submit" || SUBMIT_TEXT.test(control.value);
    }
    return SUBMIT_TEXT.test(control.textContent ?? "");
  }

  /**
   * @param source the element the user acted on
   * @param checkValidity true for clicks and Enter, where the browser may still block the
   *   submit (a real submit event means validation already passed)
   */
  private handle(source: Element, checkValidity: boolean): void {
    if (!this.options.isUserActivated()) return;

    for (const form of findCaptureForms(this.doc, this.visible)) {
      if (!form.container.contains(source) && form.container !== source) continue;
      if (checkValidity && form.container instanceof HTMLFormElement) {
        if (!form.container.checkValidity()) return;
      }
      const credentials = this.read(form);
      if (!credentials) return;

      const at = this.now();
      if (this.last && this.last.container === form.container && at - this.last.at < DEDUPE_MS) {
        return; // The same submission seen through a click, Enter and a submit event.
      }
      this.last = { container: form.container, at };
      this.options.onCapture(credentials);
      return;
    }
  }

  private read(form: CaptureForm): CapturedCredentials | null {
    const password = form.newPassword.value;
    if (password === "") return null;
    // A repeat-password field that does not match means the form will not be accepted.
    if (form.confirm && form.confirm.value !== password) return null;
    return {
      kind: form.kind,
      username: form.username?.value.trim() ?? "",
      password,
    };
  }
}
