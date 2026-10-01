// File helpers: atomic writes (temp file + rename) and quiet deletes.

import fs from 'node:fs';
import path from 'node:path';

function tempPathFor(filePath: string): string {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
}

export async function writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = tempPathFor(filePath);
  try {
    await fs.promises.writeFile(tmp, data, { mode: 0o600 });
    try {
      await fs.promises.rename(tmp, filePath);
    } catch {
      // Windows can briefly lock the target (antivirus, indexer); retry once.
      await new Promise((r) => setTimeout(r, 50));
      await fs.promises.rename(tmp, filePath);
    }
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export function writeFileAtomicSync(filePath: string, data: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = tempPathFor(filePath);
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    try {
      fs.renameSync(tmp, filePath);
    } catch {
      fs.renameSync(tmp, filePath);
    }
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
    throw err;
  }
}

export async function removeFileQuiet(filePath: string): Promise<void> {
  await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
}
