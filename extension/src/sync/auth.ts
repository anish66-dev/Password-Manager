import { StorageError } from "@password-manager/shared";
import { type TokenProvider } from "./drive-adapter.js";

/**
 * Storage sign-in through Chrome's identity API (manifest "oauth2" block, drive.appdata scope).
 * Chrome keeps and refreshes the token itself. It is only ever used as a bearer token for
 * Drive, is never stored by this extension, and is unrelated to the vault keys.
 */
export class ChromeTokenProvider implements TokenProvider {
  async getToken(interactive: boolean): Promise<string> {
    try {
      const result: unknown = await chrome.identity.getAuthToken({ interactive });
      const token =
        typeof result === "string" ? result : (result as { token?: unknown } | undefined)?.token;
      if (typeof token === "string" && token !== "") return token;
    } catch {
      // Not signed in, consent declined or revoked, or no OAuth client configured.
    }
    throw new StorageError("AUTH");
  }

  async invalidate(token: string): Promise<void> {
    try {
      await chrome.identity.removeCachedAuthToken({ token });
    } catch {
      // Nothing cached to remove.
    }
  }

  /** Forgets the token and revokes this extension's access to the Drive app data folder. */
  async signOut(): Promise<void> {
    let token: string | null = null;
    try {
      token = await this.getToken(false);
    } catch {
      return; // Already signed out.
    }
    await this.invalidate(token);
    try {
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
      });
    } catch {
      // Offline: the local token is already forgotten.
    }
  }
}
