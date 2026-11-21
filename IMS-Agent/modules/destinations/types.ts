import type { Writable } from 'node:stream';

export interface DestinationUpload {
  /** Stream the final (compressed / encrypted) archive bytes into this. */
  stream: Writable;
  /** Makes the archive visible (rename / complete multipart). Returns its location URI. */
  commit(): Promise<string>;
  /** Discards any partial data. */
  abort(): Promise<void>;
}

export interface StoredArchive {
  name: string;
  sizeBytes?: number;
}

/**
 * A place where archives of ONE job are stored. Implementations must only
 * ever list/remove objects inside that job's own namespace.
 */
export interface Destination {
  describe(): string;
  preflight(): Promise<void>;
  open(name: string): Promise<DestinationUpload>;
  list(): Promise<StoredArchive[]>;
  remove(name: string): Promise<void>;
}
