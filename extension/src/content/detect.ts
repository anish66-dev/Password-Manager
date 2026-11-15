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

/** A form where the user chooses a new password: registration or password change. */
export interface CaptureForm {
  kind: "register" | "change";
  /** The new password the user typed. */
  newPassword: HTMLInputElement;
  /** The repeat-password field, when the form has one. */
  confirm: HTMLInputElement | null;
  /** Visible username or email field, or a hidden autocomplete="username" field. */
  username: HTMLInputElement | null;
  /** Element that contains the whole form (a <form> or a nearby container). */
  container: Element;
}

const NEW_HINT = /new.?pass|new.?pwd|nieuw|neu.?pass/i;
const CURRENT_HINT = /current|old|existing|previous|cur.?pass/i;

function autocompleteOf(input: HTMLInputElement): string {
  return (input.getAttribute("autocomplete") ?? "").toLowerCase();
}

function hintText(input: HTMLInputElement): string {
  return `${input.name} ${input.id} ${input.placeholder} ${input.getAttribute("aria-label") ?? ""}`;
}

function looksNew(input: HTMLInputElement): boolean {
  return autocompleteOf(input) === "new-password" || NEW_HINT.test(hintText(input));
}

function looksCurrent(input: HTMLInputElement): boolean {
  return autocompleteOf(input) === "current-password" || CURRENT_HINT.test(hintText(input));
}

const CONTAINER_SELECTOR = "form, dialog, [role='dialog'], section, article, main";

function groupContainer(password: HTMLInputElement): Element {
  return password.form ?? password.closest(CONTAINER_SELECTOR) ?? password.ownerDocument.body;
}

/** Username or email for a form: visible field first, then a hidden autocomplete="username". */
function findCaptureUsername(
  firstPassword: HTMLInputElement,
  container: Element,
  visible: VisibilityCheck
): HTMLInputElement | null {
  const found = findUsernameFor(firstPassword, visible);
  if (found) return found;
  const hidden = container.querySelector<HTMLInputElement>(
    'input[autocomplete~="username"], input[autocomplete~="email"]'
  );
  return hidden && !hidden.disabled ? hidden : null;
}

/**
 * Finds registration and change-password forms:
 *  - two password fields and no "current password" first field: new + confirm (registration)
 *  - current + new (+ confirm): change password
 *  - a lone field that says it is a new password: change password
 */
export function findCaptureForms(
  root: ParentNode,
  visible: VisibilityCheck = isVisible
): CaptureForm[] {
  const groups = new Map<Element, HTMLInputElement[]>();
  for (const password of root.querySelectorAll<HTMLInputElement>('input[type="password"]')) {
    if (!isUsable(password, visible)) continue;
    const container = groupContainer(password);
    const list = groups.get(container) ?? [];
    list.push(password);
    groups.set(container, list);
  }

  const forms: CaptureForm[] = [];
  for (const [container, passwords] of groups) {
    const first = passwords[0];
    if (!first) continue;
    const username = (): HTMLInputElement | null => findCaptureUsername(first, container, visible);

    if (passwords.length === 1) {
      if (looksNew(first)) {
        forms.push({
          kind: "change",
          newPassword: first,
          confirm: null,
          username: username(),
          container,
        });
      }
      continue;
    }

    const second = passwords[1];
    if (!second) continue;
    if (passwords.length === 2) {
      const firstIsCurrent = looksCurrent(first) && !looksNew(first);
      forms.push(
        firstIsCurrent
          ? { kind: "change", newPassword: second, confirm: null, username: username(), container }
          : {
              kind: "register",
              newPassword: first,
              confirm: second,
              username: username(),
              container,
            }
      );
      continue;
    }

    // Three or more: current, new, confirm.
    forms.push({
      kind: "change",
      newPassword: second,
      confirm: passwords[2] ?? null,
      username: username(),
      container,
    });
  }
  return forms;
}
