import {
  type RemoteFile,
  type StorageAdapter,
  StorageError,
  type StorageErrorCode,
} from "./types.js";

interface StoredFile {
  id: string;
  name: string;
  content: string;
  revision: string;
}

/**
 * In-memory fake of a cloud folder for tests. Like Drive, names are not unique: uploading
 * without an ID always creates a new file. Test helpers let a test play the part of a
 * misbehaving provider (tampering, rollbacks, outages).
 */
export class InMemoryStorageAdapter implements StorageAdapter {
  private readonly files = new Map<string, StoredFile>();
  private nextId = 1;
  private nextRevision = 1;
  private failures: StorageErrorCode[] = [];
  /** When true every call fails with a network error. */
  offline = false;
  /** Names of every file ever uploaded, in order, for assertions about what leaves the device. */
  readonly uploads: Array<{ name: string; content: string }> = [];

  private guard(): void {
    if (this.offline) throw new StorageError("NETWORK");
    const failure = this.failures.shift();
    if (failure) throw new StorageError(failure);
  }

  /** The next call fails with this error. */
  failNext(code: StorageErrorCode): void {
    this.failures.push(code);
  }

  async list(): Promise<RemoteFile[]> {
    this.guard();
    return [...this.files.values()].map(({ id, name, revision }) => ({ id, name, revision }));
  }

  async download(id: string): Promise<string> {
    this.guard();
    const file = this.files.get(id);
    if (!file) throw new StorageError("NOT_FOUND");
    return file.content;
  }

  async upload(name: string, content: string, existingId?: string): Promise<RemoteFile> {
    this.guard();
    this.uploads.push({ name, content });
    let file: StoredFile;
    if (existingId !== undefined) {
      const found = this.files.get(existingId);
      if (!found) throw new StorageError("NOT_FOUND");
      file = found;
      file.content = content;
      file.name = name;
    } else {
      file = { id: `file-${this.nextId++}`, name, content, revision: "" };
      this.files.set(file.id, file);
    }
    file.revision = `rev-${this.nextRevision++}`;
    return { id: file.id, name: file.name, revision: file.revision };
  }

  async delete(id: string): Promise<void> {
    this.guard();
    if (!this.files.delete(id)) throw new StorageError("NOT_FOUND");
  }

  // ----- Test helpers (play the cloud provider) -----

  /** All files with this name. */
  find(name: string): StoredFile[] {
    return [...this.files.values()].filter((f) => f.name === name);
  }

  names(): string[] {
    return [...this.files.values()].map((f) => f.name).sort();
  }

  /** Every stored byte, for scanning for plaintext. */
  dump(): string {
    return [...this.files.values()].map((f) => `${f.name}\n${f.content}`).join("\n");
  }

  /** Replaces a file's content as a provider (or attacker) could, bumping its revision. */
  tamper(name: string, change: (content: string) => string): void {
    const file = this.find(name)[0];
    if (!file) throw new Error(`No file named ${name}`);
    file.content = change(file.content);
    file.revision = `rev-${this.nextRevision++}`;
  }

  /** Captures a file so it can be put back later (a provider serving an old copy). */
  snapshot(name: string): string {
    const file = this.find(name)[0];
    if (!file) throw new Error(`No file named ${name}`);
    return file.content;
  }

  restore(name: string, content: string): void {
    this.tamper(name, () => content);
  }

  /** Adds a second file with an existing name, as two racing clients could create. */
  addDuplicate(name: string, content: string): RemoteFile {
    const file: StoredFile = {
      id: `file-${this.nextId++}`,
      name,
      content,
      revision: `rev-${this.nextRevision++}`,
    };
    this.files.set(file.id, file);
    return { id: file.id, name, revision: file.revision };
  }

  /** Removes a file as a provider could ("provider-side deletion"). */
  remove(name: string): void {
    for (const file of this.find(name)) this.files.delete(file.id);
  }
}
