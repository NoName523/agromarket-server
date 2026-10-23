import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';

const envPath = new URL('../.env', import.meta.url);
const tempPath = new URL('../.env.rotate.tmp', import.meta.url);
let wroteTemp = false;

try {
  if (process.argv[2] !== '--confirm') throw new Error('Confirmation required');
  const contents = await readFile(envPath, 'utf8');
  if (!/^JWT_SECRET=.+$/m.test(contents)) throw new Error('JWT_SECRET missing');
  const secret = randomBytes(64).toString('base64url');
  const updated = contents.replace(/^JWT_SECRET=.+$/m, `JWT_SECRET=${secret}`);
  await writeFile(tempPath, updated, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  wroteTemp = true;
  await rename(tempPath, envPath);
  console.log('JWT_SECRET обновлён в локальном .env. Перезапустите сервер; старые JWT станут недействительными.');
} catch {
  if (wroteTemp) {
    try { await unlink(tempPath); } catch { /* no temporary file */ }
  }
  console.error('Ротация JWT_SECRET не выполнена; проверьте локальный .env.');
  process.exitCode = 1;
}
