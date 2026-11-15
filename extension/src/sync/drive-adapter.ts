import { type RemoteFile, type StorageAdapter, StorageError } from "@password-manager/shared";

/** Supplies OAuth access tokens. The token only grants access to ciphertext, never to keys. */
export interface TokenProvider {
  /** Throws StorageError("AUTH") when no token can be had (for example not signed in). */
  getToken(interactive: boolean): Promise<string>;
  /** Forget a token that Drive rejected, so the next call fetches a fresh one. */
  invalidate(token: string): Promise<void>;
}

export interface DriveAdapterOptions {
  tokens: TokenProvider;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Attempts for 429/5xx/network failures. */
  maxAttempts?: number;
}

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FILE_FIELDS = "id,name,md5Checksum,modifiedTime,version";
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

interface DriveFile {
  id?: string;
  name?: string;
  md5Checksum?: string;
  modifiedTime?: string;
  version?: string;
}

function toRemoteFile(file: DriveFile): RemoteFile {
  if (typeof file.id !== "string" || typeof file.name !== "string") {
    throw new StorageError("SERVER");
  }
  // A checksum changes exactly when the content does. Fall back to time + version.
  const revision = file.md5Checksum ?? `${file.modifiedTime ?? ""}|${file.version ?? ""}`;
  return { id: file.id, name: file.name, revision };
}

/**
 * StorageAdapter over Google Drive REST v3, restricted to the hidden appDataFolder space
 * (drive.appdata scope): the app cannot see any other Drive file. Handles pagination, token
 * refresh on 401, and backoff on 429 and 5xx. Nothing but ciphertext and the vault header is
 * ever sent, and error messages never contain tokens or file contents.
 */
export class DriveAdapter implements StorageAdapter {
  private readonly tokens: TokenProvider;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly maxAttempts: number;

  constructor(options: DriveAdapterOptions) {
    this.tokens = options.tokens;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.maxAttempts = options.maxAttempts ?? 5;
  }

  async list(): Promise<RemoteFile[]> {
    const files: RemoteFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        spaces: "appDataFolder",
        pageSize: "1000",
        fields: `nextPageToken,files(${FILE_FIELDS})`,
      });
      if (pageToken) params.set("pageToken", pageToken);
      const body = await this.json(await this.call(`${API}/files?${params}`, { method: "GET" }));
      const page = body as { files?: DriveFile[]; nextPageToken?: string };
      for (const file of page.files ?? []) files.push(toRemoteFile(file));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }

  async download(id: string): Promise<string> {
    const params = new URLSearchParams({ alt: "media" });
    const res = await this.call(`${API}/files/${encodeURIComponent(id)}?${params}`, {
      method: "GET",
    });
    return res.text();
  }

  async upload(name: string, content: string, existingId?: string): Promise<RemoteFile> {
    const fields = new URLSearchParams({ fields: FILE_FIELDS });
    if (existingId !== undefined) {
      const url = `${UPLOAD_API}/files/${encodeURIComponent(existingId)}?uploadType=media&${fields}`;
      const res = await this.call(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: content,
      });
      return toRemoteFile((await this.json(res)) as DriveFile);
    }

    const boundary = `pm-${crypto.randomUUID()}`;
    const metadata = { name, parents: ["appDataFolder"], mimeType: "application/json" };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n` +
      `--${boundary}--`;
    const res = await this.call(`${UPLOAD_API}/files?uploadType=multipart&${fields}`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    return toRemoteFile((await this.json(res)) as DriveFile);
  }

  async delete(id: string): Promise<void> {
    await this.call(`${API}/files/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  private async json(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      throw new StorageError("SERVER");
    }
  }

  private backoff(attempt: number, retryAfter: string | null): number {
    const seconds = retryAfter === null ? NaN : Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_DELAY_MS);
    const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
    return Math.round(exp * (0.5 + this.random() / 2));
  }

  /** One logical request: token, retry on 401 once, back off on 429 and 5xx, map errors. */
  private async call(url: string, init: RequestInit): Promise<Response> {
    let attempt = 0;
    let refreshedAuth = false;
    for (;;) {
      const token = await this.tokens.getToken(false);
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          ...init,
          headers: {
            ...(init.headers as Record<string, string> | undefined),
            Authorization: `Bearer ${token}`,
          },
        });
      } catch {
        if (++attempt >= this.maxAttempts) throw new StorageError("NETWORK");
        await this.sleep(this.backoff(attempt - 1, null));
        continue;
      }

      if (res.ok) return res;

      if (res.status === 401) {
        await this.tokens.invalidate(token); // The cached token is bad: drop it and retry once.
        if (refreshedAuth) throw new StorageError("AUTH");
        refreshedAuth = true;
        continue;
      }
      if (res.status === 404) throw new StorageError("NOT_FOUND");

      let retryable = res.status === 429 || res.status >= 500;
      if (res.status === 403) {
        // Drive reports quota and rate limits as 403. Anything else is a permission problem.
        const reason = await rateLimitReason(res);
        if (!reason) throw new StorageError("AUTH");
        retryable = true;
      }
      if (!retryable) throw new StorageError("SERVER");

      if (++attempt >= this.maxAttempts) {
        throw new StorageError(res.status >= 500 ? "SERVER" : "RATE_LIMITED");
      }
      await this.sleep(this.backoff(attempt - 1, res.headers.get("retry-after")));
    }
  }
}

async function rateLimitReason(res: Response): Promise<boolean> {
  try {
    const body = (await res.json()) as { error?: { errors?: Array<{ reason?: string }> } };
    return (body.error?.errors ?? []).some((e) => /ratelimit|quota/i.test(e.reason ?? ""));
  } catch {
    return false;
  }
}
