/** Tiny async key/value interface so session logic is testable without chrome.*. */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(...keys: string[]): Promise<void>;
}

export class MemoryKeyValueStore implements KeyValueStore {
  private readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }

  async remove(...keys: string[]): Promise<void> {
    for (const key of keys) this.data.delete(key);
  }
}

type ChromeArea = chrome.storage.StorageArea;

function fromArea(area: () => ChromeArea): KeyValueStore {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const result = await area().get(key);
      return result[key] as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      await area().set({ [key]: value });
    },
    async remove(...keys: string[]): Promise<void> {
      await area().remove(keys);
    },
  };
}

/**
 * RAM-only, cleared when the browser restarts or the extension reloads. Default access
 * level is kept (trusted contexts only), so content scripts cannot read it.
 */
export const chromeSessionStore: KeyValueStore = fromArea(() => chrome.storage.session);

/** Non-secret settings only (for example the auto-lock timeout). */
export const chromeLocalStore: KeyValueStore = fromArea(() => chrome.storage.local);
