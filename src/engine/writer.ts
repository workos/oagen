import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { GeneratedFile } from './types.js';

export async function writeFiles(files: GeneratedFile[], outputDir: string): Promise<void> {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sorted) {
    const fullPath = path.join(outputDir, file.path);
    if (file.skipIfExists) {
      try {
        await fs.access(fullPath);
        continue; // File exists, skip
      } catch {
        // File doesn't exist, write it
      }
    }
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, file.content, 'utf-8');
  }
}
