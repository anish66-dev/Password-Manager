import {
  type CaptureDecision,
  type CaptureKind,
  type CapturePrompt,
  type LoginEntry,
  type MatchOptions,
  type Vault,
  matchesPage,
  pageSiteKey,
} from "@password-manager/shared";
import { ServiceError, type VaultService } from "./vault-service.js";

/** How long a captured credential waits for a prompt (for example across a redirect). */
export const CAPTURE_TTL_MS = 60_000;

export interface PendingCapture {
  /** Page URL from the browser-provided sender at capture time. */
  url: string;
  kind: CaptureKind;
  username: string;
  password: string;
  capturedAt: number;
}

/**
 * Captured credentials waiting for the user's decision, keyed by tab. Memory only: never
 * written to any storage, never logged, dropped after a short expiry or when the tab closes.
 */
export class PendingCaptures {
  private readonly captures = new Map<number, PendingCapture>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  set(tabId: number, capture: Omit<PendingCapture, "capturedAt">): void {
    this.captures.set(tabId, { ...capture, capturedAt: this.now() });
  }

  get(tabId: number): PendingCapture | undefined {
    const found = this.captures.get(tabId);
    if (!found) return undefined;
    if (this.now() - found.capturedAt > CAPTURE_TTL_MS) {
      this.captures.delete(tabId);
      return undefined;
    }
    return found;
  }

  delete(tabId: number): void {
    this.captures.delete(tabId);
  }

  /** Tabs that still have an unexpired capture. */
  tabIds(): number[] {
    return [...this.captures.keys()].filter((tabId) => this.get(tabId) !== undefined);
  }
}

export interface CaptureDeps {
  service: VaultService;
  allowLocalhost: boolean;
  captures: PendingCaptures;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The saved login this capture would update: the same registrable domain and username.
 * When the page has no username field (a change-password page), a single saved login on
 * the domain is assumed.
 */
async function findExisting(
  vault: Vault,
  capture: PendingCapture,
  options: MatchOptions
): Promise<LoginEntry | null> {
  const onDomain = (await vault.list()).filter((entry) =>
    matchesPage(entry.url, capture.url, options)
  );
  const name = normalizeName(capture.username);
  const sameUser = onDomain.find((entry) => normalizeName(entry.username) === name);
  if (sameUser) return sameUser;
  if (name === "" && onDomain.length === 1) return onDomain[0] ?? null;
  return null;
}

/**
 * Works out what to show for a tab's pending capture, or null for nothing. The page showing
 * the prompt must be on the same site as the capture, so a redirect to an unrelated site
 * never sees it.
 */
export async function resolvePrompt(
  deps: CaptureDeps,
  tabId: number,
  pageUrl: string | undefined
): Promise<CapturePrompt | null> {
  const capture = deps.captures.get(tabId);
  if (!capture) return null;
  const options: MatchOptions = { allowLocalhost: deps.allowLocalhost };

  const site = pageSiteKey(capture.url, options);
  if (site === null) {
    deps.captures.delete(tabId);
    return null;
  }
  if (pageUrl !== undefined && pageSiteKey(pageUrl, options) !== site) return null;

  const base = { site, username: capture.username, passwordLength: capture.password.length };
  const status = await deps.service.getStatus();
  if (status === "uninitialized") return null;
  if (status === "locked") return { mode: "unlock", ...base };

  let vault: Vault;
  try {
    vault = await deps.service.requireVault();
  } catch (err) {
    if (err instanceof ServiceError && err.code === "LOCKED") return { mode: "unlock", ...base };
    throw err;
  }

  if ((await vault.readNeverSave()).includes(site)) {
    deps.captures.delete(tabId);
    return null;
  }

  const existing = await findExisting(vault, capture, options);
  if (existing) {
    if (existing.password === capture.password) {
      deps.captures.delete(tabId); // nothing changed, nothing to ask
      return null;
    }
    return { mode: "update", ...base, username: existing.username || capture.username };
  }
  return { mode: "save", ...base };
}

export type DecisionResult = { ok: true } | { ok: false; error: string };

/** Applies the user's decision to the tab's pending capture. */
export async function applyDecision(
  deps: CaptureDeps,
  tabId: number,
  pageUrl: string | undefined,
  decision: CaptureDecision
): Promise<DecisionResult> {
  const capture = deps.captures.get(tabId);
  if (!capture) return { ok: false, error: "This prompt has expired." };
  const options: MatchOptions = { allowLocalhost: deps.allowLocalhost };

  const site = pageSiteKey(capture.url, options);
  if (site === null || pageUrl === undefined || pageSiteKey(pageUrl, options) !== site) {
    return { ok: false, error: "This prompt does not belong to this site." };
  }

  if (decision === "dismiss") {
    deps.captures.delete(tabId); // Nothing is stored or sent.
    return { ok: true };
  }

  const vault = await deps.service.requireVault(); // Throws ServiceError("LOCKED") if locked.

  if (decision === "never") {
    await vault.addNeverSave(site);
    deps.captures.delete(tabId);
    return { ok: true };
  }

  // accept: the worker, not the page, decides between adding and updating.
  const existing = await findExisting(vault, capture, options);
  if (existing) {
    if (existing.password !== capture.password) {
      await vault.update(existing.id, {
        url: existing.url,
        username: existing.username === "" ? capture.username : existing.username,
        password: capture.password,
      });
    }
  } else {
    await vault.add({
      url: new URL(capture.url).origin,
      username: capture.username,
      password: capture.password,
    });
  }
  deps.captures.delete(tabId);
  return { ok: true };
}
