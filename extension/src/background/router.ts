import {
  type ExtensionResponse,
  type LoginDetail,
  type LoginEntry,
  type LoginSummary,
  MIN_MASTER_PASSWORD_LENGTH,
  StorageError,
  SyncError,
  VaultCryptoError,
  VaultError,
  type MatchOptions,
  type Suggestion,
  allowedSenderKind,
  isValidExtensionMessage,
  matchesPage,
  pageSiteKey,
  recordSiteKey,
} from "@password-manager/shared";
import { ServiceError } from "./vault-service.js";
import { type CaptureDeps, applyDecision, resolvePrompt } from "./capture-flow.js";
import { type SyncService } from "./sync-service.js";

export const APP_NAME = "Personal Password Manager";
export const APP_VERSION = "0.1.0";

/** Facts about the sender, computed in index.ts from the browser's own `sender` object. */
export interface SenderInfo {
  /** URL of the sending page, as reported by the browser (never page-supplied data). */
  url?: string;
  /** True only for pages of this extension (popup). */
  isExtensionPage: boolean;
  /** True when the sender is a content script in the top frame of a tab. */
  isContentScript: boolean;
  /** True when the sender is our own suggestion iframe embedded in a page. */
  isSuggestionFrame: boolean;
  /** Tab of the sender, as reported by the browser. */
  tabId?: number;
}

export interface RouterDeps extends CaptureDeps {
  /** One pending iframe-authentication nonce per tab. Memory only. */
  frameNonces: Map<number, string>;
  /** Called after the vault is created or unlocked, so tabs can retry a waiting prompt. */
  onUnlocked?: () => void;
  /** Cloud sync. Absent in contexts that have no sync (some tests). */
  sync?: SyncService;
}

function senderMatches(kind: string, sender: SenderInfo): boolean {
  switch (kind) {
    case "extension-page":
      return sender.isExtensionPage;
    case "content-script":
      return sender.isContentScript;
    default:
      return sender.isSuggestionFrame;
  }
}

function summarize(entry: LoginEntry): LoginSummary {
  return {
    id: entry.id,
    url: entry.url,
    username: entry.username,
    modified_at: entry.modified_at,
    conflict: entry.conflict_of !== undefined,
  };
}

function detail(entry: LoginEntry): LoginDetail {
  return { ...summarize(entry), password: entry.password };
}

function fail(error: string): ExtensionResponse<never> {
  return { ok: false, error };
}

/**
 * Handles incoming messages at the service worker boundary with strict runtime validation.
 * Vault messages are only accepted from extension pages, never from content scripts.
 */
export async function handleExtensionMessage(
  rawMessage: unknown,
  sender: SenderInfo,
  deps: RouterDeps
): Promise<ExtensionResponse<unknown>> {
  const { service } = deps;
  const matchOptions: MatchOptions = { allowLocalhost: deps.allowLocalhost };
  if (!isValidExtensionMessage(rawMessage)) {
    return fail("Invalid message payload or unrecognized message type at boundary.");
  }
  const message = rawMessage;

  if (!senderMatches(allowedSenderKind(message), sender)) {
    return fail("This message is not allowed from this context.");
  }

  try {
    switch (message.type) {
      case "POPUP_GET_STATUS": {
        return {
          ok: true,
          data: {
            appName: APP_NAME,
            version: APP_VERSION,
            status: await service.getStatus(),
            autoLockMinutes: await service.getAutoLockMinutes(),
            timestamp: new Date().toISOString(),
          },
        };
      }

      case "CONTENT_SCRIPT_PING": {
        return {
          ok: true,
          data: {
            acknowledged: true,
            // The origin comes from the browser-provided sender, never from page-supplied data.
            receivedFromUrl: sender.url ?? "unknown",
            timestamp: new Date().toISOString(),
          },
        };
      }

      case "LOGIN_FIELD_FOCUSED": {
        // The page is identified only by the browser-provided sender URL.
        const pageUrl = sender.url;
        const none = (state: "ineligible" | "uninitialized" | "locked") => ({
          ok: true as const,
          data: { state, suggestions: [] as Suggestion[] },
        });
        if (!pageUrl || pageSiteKey(pageUrl, matchOptions) === null) return none("ineligible");
        const status = await service.getStatus();
        if (status === "uninitialized") return none("uninitialized");
        if (status === "locked") return none("locked");
        const vault = await service.requireVault();
        const suggestions: Suggestion[] = (await vault.list())
          .filter((entry) => matchesPage(entry.url, pageUrl, matchOptions))
          .map((entry) => ({
            id: entry.id,
            username: entry.username,
            displayDomain: recordSiteKey(entry.url, matchOptions) ?? "",
          }));
        return { ok: true, data: { state: "ready", suggestions } };
      }

      case "FILL_REQUEST": {
        const pageUrl = sender.url;
        const vault = await service.requireVault();
        const entry = await vault.get(message.payload.id);
        // Re-check the origin against the chosen record before releasing any secret.
        if (!pageUrl || !matchesPage(entry.url, pageUrl, matchOptions)) {
          return fail("No matching login for this site.");
        }
        return { ok: true, data: { username: entry.username, password: entry.password } };
      }

      case "FRAME_REGISTER": {
        if (sender.tabId === undefined) return fail("Frame not authorized.");
        deps.frameNonces.set(sender.tabId, message.payload.nonce);
        return { ok: true, data: { done: true } };
      }

      case "FRAME_CLAIM": {
        const tabId = sender.tabId;
        if (tabId === undefined || deps.frameNonces.get(tabId) !== message.payload.nonce) {
          return fail("Frame not authorized.");
        }
        deps.frameNonces.delete(tabId);
        return { ok: true, data: { done: true } };
      }

      case "CREDENTIAL_CAPTURED": {
        const tabId = sender.tabId;
        const pageUrl = sender.url;
        // Only https pages (or localhost in dev builds) are ever offered a save prompt.
        if (tabId === undefined || !pageUrl || pageSiteKey(pageUrl, matchOptions) === null) {
          return { ok: true, data: { prompt: null } };
        }
        deps.captures.set(tabId, { url: pageUrl, ...message.payload });
        return { ok: true, data: { prompt: await resolvePrompt(deps, tabId, pageUrl) } };
      }

      case "PENDING_CAPTURE_GET": {
        if (sender.tabId === undefined) return { ok: true, data: { prompt: null } };
        return { ok: true, data: { prompt: await resolvePrompt(deps, sender.tabId, sender.url) } };
      }

      case "CAPTURE_DECISION": {
        if (sender.tabId === undefined) return fail("Not allowed.");
        const result = await applyDecision(
          deps,
          sender.tabId,
          sender.url,
          message.payload.decision
        );
        if (result.ok && message.payload.decision !== "dismiss") deps.sync?.scheduleSync();
        return result.ok ? { ok: true, data: { done: true } } : fail(result.error);
      }

      case "VAULT_CREATE":
        await service.create(message.payload.password);
        deps.onUnlocked?.();
        deps.sync?.onUnlocked();
        return { ok: true, data: { done: true } };

      case "VAULT_UNLOCK":
        try {
          await service.unlock(message.payload.password);
        } catch (err) {
          // After a master password change on another device the local header is stale.
          // The new password unlocks the newer cloud header, which is then adopted.
          const wrong = err instanceof VaultError && err.code === "BAD_PASSWORD";
          if (!wrong || !deps.sync || !(await deps.sync.hasPendingHeader())) throw err;
          try {
            await deps.sync.applyNewPassword(message.payload.password);
          } catch {
            throw err; // Report the original wrong-password error, nothing more.
          }
        }
        deps.onUnlocked?.();
        deps.sync?.onUnlocked();
        return { ok: true, data: { done: true } };

      case "VAULT_LOCK":
        await service.lock();
        return { ok: true, data: { done: true } };

      case "VAULT_LIST": {
        const vault = await service.requireVault();
        const result = await vault.search(message.payload.query);
        return {
          ok: true,
          data: { entries: result.entries.map(summarize), rejected: result.rejectedIds.length },
        };
      }

      case "VAULT_GET": {
        const vault = await service.requireVault();
        return { ok: true, data: { entry: detail(await vault.get(message.payload.id)) } };
      }

      case "VAULT_ADD": {
        const vault = await service.requireVault();
        const { url, username, password } = message.payload;
        const entry = await vault.add({ url, username, password });
        deps.sync?.scheduleSync();
        return { ok: true, data: { entry: detail(entry) } };
      }

      case "VAULT_UPDATE": {
        const vault = await service.requireVault();
        const { id, url, username, password } = message.payload;
        const entry = await vault.update(id, { url, username, password });
        deps.sync?.scheduleSync();
        return { ok: true, data: { entry: detail(entry) } };
      }

      case "VAULT_DELETE": {
        const vault = await service.requireVault();
        await vault.delete(message.payload.id);
        deps.sync?.scheduleSync();
        return { ok: true, data: { done: true } };
      }

      case "VAULT_CHANGE_PASSWORD": {
        const vault = await service.requireVault();
        const { currentPassword, newPassword } = message.payload;
        if (newPassword.length < MIN_MASTER_PASSWORD_LENGTH) {
          throw new ServiceError("WEAK_PASSWORD");
        }
        await vault.changeMasterPassword(currentPassword, newPassword);
        deps.sync?.scheduleSync();
        return { ok: true, data: { done: true } };
      }

      case "SYNC_GET_STATUS":
        return deps.sync
          ? { ok: true, data: await deps.sync.getStatus() }
          : fail("Sync is not available.");

      case "SYNC_SIGN_IN":
        return deps.sync
          ? { ok: true, data: await deps.sync.signIn() }
          : fail("Sync is not available.");

      case "SYNC_SIGN_OUT":
        return deps.sync
          ? { ok: true, data: await deps.sync.signOut() }
          : fail("Sync is not available.");

      case "SYNC_NOW":
        return deps.sync
          ? { ok: true, data: await deps.sync.syncNow() }
          : fail("Sync is not available.");

      case "SYNC_CHECK_REMOTE":
        return deps.sync
          ? { ok: true, data: { exists: await deps.sync.remoteVaultExists() } }
          : fail("Sync is not available.");

      case "SYNC_SETUP_FROM_CLOUD": {
        if (!deps.sync) return fail("Sync is not available.");
        await deps.sync.setupFromCloud(message.payload.password);
        deps.onUnlocked?.();
        return { ok: true, data: { done: true } };
      }

      case "SYNC_APPLY_NEW_PASSWORD": {
        if (!deps.sync) return fail("Sync is not available.");
        await deps.sync.applyNewPassword(message.payload.password);
        return { ok: true, data: { done: true } };
      }

      case "VAULT_SET_AUTOLOCK":
        await service.setAutoLockMinutes(message.payload.minutes);
        return { ok: true, data: { done: true } };
    }
  } catch (err) {
    // Only fixed, secret-free messages reach the caller. Everything else is generic.
    if (
      err instanceof ServiceError ||
      err instanceof VaultError ||
      err instanceof SyncError ||
      err instanceof StorageError
    ) {
      return fail(err.message);
    }
    if (err instanceof VaultCryptoError) {
      return fail("The vault data could not be verified.");
    }
    return fail("Internal error.");
  }
}
