/** A password field and the username or email field that goes with it. */
export interface LoginForm {
  password: HTMLInputElement;
  username: HTMLInputElement | null;
}

export type VisibilityCheck = (el: HTMLElement) => boolean;

const MIN_SIZE_PX = 4;
const USERNAME_TYPES = new Set(["text", "email", "tel", ""]);
const NAME_HINT = /user|e-?mail|login|account|identifier|phone|signin|sign-in/i;
const NAME_EXCLUDE = /search|captcha|otp|totp|token|code|zip|postal|coupon|promo|first|last|city/i;

/**
 * False for anything a user cannot see or use: display:none, visibility:hidden, opacity 0,
 * zero or tiny size, positioned off-screen, or inert. Honeypot fields must never match.
 */
export function isVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
  const checker = (
    el as HTMLElement & {
      checkVisibility?: (options?: Record<string, boolean>) => boolean;
    }
  ).checkVisibility;
  if (typeof checker === "function") {
    if (!checker.call(el, { checkOpacity: true, checkVisibilityCSS: true })) return false;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width < MIN_SIZE_PX || rect.height < MIN_SIZE_PX) return false;
  const win = el.ownerDocument.defaultView;
  const scrollX = win?.scrollX ?? 0;
  const scrollY = win?.scrollY ?? 0;
  // Off-screen means outside the page's top-left quadrant, not merely below the fold.
  if (rect.right + scrollX <= 0 || rect.bottom + scrollY <= 0) return false;
  return true;
}

function isUsable(input: HTMLInputElement, visible: VisibilityCheck): boolean {
  return !input.disabled && !input.readOnly && visible(input);
}

function scoreUsernameCandidate(input: HTMLInputElement): number {
  const autocomplete = (input.getAttribute("autocomplete") ?? "").toLowerCase();
  const hints = `${input.name} ${input.id} ${input.placeholder} ${
    input.getAttribute("aria-label") ?? ""
  }`;
  let score = 0;
  if (/\b(username|email)\b/.test(autocomplete)) score += 4;
  if (input.type === "email") score += 2;
  if (NAME_HINT.test(hints)) score += 2;
  if (NAME_EXCLUDE.test(hints)) score -= 4;
  return score;
}

/** The visible text-like input that most likely holds the username for this password. */
export function findUsernameFor(
  password: HTMLInputElement,
  visible: VisibilityCheck = isVisible
): HTMLInputElement | null {
  const scope: ParentNode = password.form ?? password.ownerDocument;
  const inputs = Array.from(scope.querySelectorAll<HTMLInputElement>("input"));
  const passwordIndex = inputs.indexOf(password);
  if (passwordIndex <= 0) return null;

  let best: HTMLInputElement | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  // Walk backwards so that, on equal scores, the closest preceding field wins.
  for (let i = passwordIndex - 1; i >= 0; i--) {
    const candidate = inputs[i];
    if (!candidate || !USERNAME_TYPES.has(candidate.type)) continue;
    if (!isUsable(candidate, visible)) continue;
    // Without a form, only look a short way back so unrelated fields are not picked up.
    if (!password.form && passwordIndex - i > 3) break;
    const score = scoreUsernameCandidate(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return bestScore >= 0 ? best : null;
}

/**
 * Finds sign-in forms: visible password inputs that are not for choosing a new password
 * (registration and password change are handled in a later phase).
 */
export function findLoginForms(
  root: ParentNode,
  visible: VisibilityCheck = isVisible
): LoginForm[] {
  const forms: LoginForm[] = [];
  for (const password of root.querySelectorAll<HTMLInputElement>('input[type="password"]')) {
    if (!isUsable(password, visible)) continue;
    if ((password.getAttribute("autocomplete") ?? "").toLowerCase() === "new-password") continue;
    forms.push({ password, username: findUsernameFor(password, visible) });
  }
  return forms;
}

/** Returns the login form a focused element belongs to, if it is one of its fields. */
export function formForField(forms: LoginForm[], target: EventTarget | null): LoginForm | null {
  for (const form of forms) {
    if (form.password === target || form.username === target) return form;
  }
  return null;
}

/**
 * Keeps an up-to-date list of login forms, including ones the page adds later, by
 * rescanning (debounced) when the DOM changes.
 */
export class FormTracker {
  private forms: LoginForm[] = [];
  private dirty = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private observer: MutationObserver | null = null;

  constructor(
    private readonly doc: Document,
    private readonly visible: VisibilityCheck = isVisible
  ) {}

  start(): void {
    if (this.observer) return;
    this.observer = new MutationObserver(() => this.markDirty());
    this.observer.observe(this.doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["type", "hidden", "style", "class", "disabled", "readonly"],
    });
    this.rescan();
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Current forms. Rescans synchronously if the page changed since the last scan. */
  getForms(): LoginForm[] {
    // Mutation callbacks are asynchronous; flush any not yet delivered.
    if (this.observer && this.observer.takeRecords().length > 0) this.dirty = true;
    if (this.dirty) this.rescan();
    return this.forms;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.dirty) this.rescan();
    }, 150);
  }

  private rescan(): void {
    this.forms = findLoginForms(this.doc, this.visible);
    this.dirty = false;
  }
}
