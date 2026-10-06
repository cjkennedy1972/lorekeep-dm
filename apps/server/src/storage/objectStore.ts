import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface ObjectStore {
  put(key: string, contents: string): Promise<void>;
  get(key: string): Promise<string>;
  delete(key: string): Promise<void>;
}

export class LocalObjectStore implements ObjectStore {
  constructor(
    private readonly directory = process.env.EXPORT_ARCHIVE_DIR ??
      '/tmp/lorekeep-exports',
  ) {}
  private path(key: string) {
    if (!/^[a-f0-9-]{36}\.json$/.test(key))
      throw new Error('Invalid archive key');
    return join(this.directory, key);
  }
  async put(key: string, contents: string) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(this.path(key), contents, { mode: 0o600 });
  }
  get(key: string) {
    return readFile(this.path(key), 'utf8');
  }
  delete(key: string) {
    return unlink(this.path(key));
  }
}
