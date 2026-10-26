import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIB = 1024 * 1024;

export async function measureImage(directory) {
  let logicalBytes = 0;
  async function visit(filename) {
    const info = await lstat(filename);
    if (info.isDirectory()) {
      for (const entry of await readdir(filename)) await visit(path.join(filename, entry));
    } else {
      // Count symlinks themselves, never their targets (notably /Applications).
      logicalBytes += info.size;
    }
  }
  await visit(directory);
  const payloadMiB = Math.ceil(logicalBytes / MIB);
  const marginMiB = Math.max(32, Math.ceil(payloadMiB / 4));
  return { logicalBytes, sizeMiB: Math.max(64, payloadMiB + marginMiB) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('请提供 DMG 内容目录。');
  const result = await measureImage(process.argv[2]);
  console.error(`DMG 内容逻辑大小：${result.logicalBytes} 字节；映像容量：${result.sizeMiB} MiB。`);
  console.log(result.sizeMiB);
}
