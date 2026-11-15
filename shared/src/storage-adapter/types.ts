/** A file in the cloud folder. */
export interface RemoteFile {
  /** Provider's file ID. Names are not unique in Drive, so IDs identify files. */
  id: string;
  /** header.json or <record_id>.json */
  name: string;
  /** Changes whenever the content changes (for example a checksum or modified time). */
  revision: string;
}

/**
 * Everything sync needs from a storage provider. The cloud folder is flat and only ever
 * receives ciphertext, the vault header and random file names. No atomic compare-and-set is
 * assumed.
 */
export interface StorageAdapter {
  /** Lists every file in the folder, following pagination. May contain duplicate names. */
  list(): Promise<RemoteFile[]>;
  /** Returns the file's text content. */
  download(id: string): Promise<string>;
  /** Creates a file, or replaces the content of `existingId` when given. */
  upload(name: string, content: string, existingId?: string): Promise<RemoteFile>;
  delete(id: string): Promise<void>;
}

export type StorageErrorCode = "AUTH" | "NETWORK" | "NOT_FOUND" | "RATE_LIMITED" | "SERVER";

const MESSAGES: Record<StorageErrorCode, string> = {
  AUTH: "Cloud sign-in is required.",
  NETWORK: "The cloud storage could not be reached.",
  NOT_FOUND: "A cloud file was not found.",
  RATE_LIMITED: "The cloud storage is busy. Try again later.",
  SERVER: "The cloud storage reported an error.",
};

/** Fixed-message error for storage failures. Never includes tokens or file contents. */
export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode) {
    super(MESSAGES[code]);
    this.name = "StorageError";
    this.code = code;
  }
}
