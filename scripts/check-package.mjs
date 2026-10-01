import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const temp = mkdtempSync(join(tmpdir(), 'dtsu-package-'));
try {
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', temp, '--json'], { cwd: root, encoding: 'utf8' }));
  for (const file of packed.files) assert.ok(!/(^|\/)(AGENTS\.md|node_modules|\.dsh)(\/|$)|\.(sqlite|db|bak|log)([-.]|$)/i.test(file.path), 'unexpected private artifact: ' + file.path);
  const modules = join(temp, 'node_modules'); mkdirSync(modules);
  for (const entry of readdirSync(join(root, 'node_modules'))) {
    if (entry !== metadata.name.split('/')[0]) symlinkSync(join(root, 'node_modules', entry), join(modules, entry));
  }
  const installed = join(modules, metadata.name); mkdirSync(installed, { recursive: true });
  execFileSync('tar', ['-xf', join(temp, packed.filename), '--strip-components=1', '-C', installed]);
  writeFileSync(join(temp, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(temp, 'consumer.ts'), [
    'import { apply, name, inject } from ' + JSON.stringify(metadata.name) + ';',
    'import type { Summary } from ' + JSON.stringify(metadata.name + '/client') + ';',
    'const handler: typeof apply = apply; const id: string = name; const services: string[] = inject;',
    'const usage: Summary | undefined = undefined; void [handler, id, services, usage];',
  ].join('\n'));
  writeFileSync(join(temp, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: false, types: ['node'],
  }, include: ['consumer.ts'] }));
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--project', join(temp, 'tsconfig.json')], { stdio: 'pipe' });
  const typeFiles = execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--project', join(temp, 'tsconfig.json'), '--listFilesOnly'], { encoding: 'utf8' });
  assert.ok(!typeFiles.includes('/@types/react/'), 'public loader types must not require internal React component declarations');
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--project', join(temp, 'tsconfig.json'),
    '--module', 'ESNext', '--moduleResolution', 'Bundler'], { stdio: 'pipe' });
  const host = await import(pathToFileURL(join(installed, 'lib/index.js')).href);
  assert.equal(typeof host.apply, 'function'); assert.equal(host.name, 'dsh-token-usage-sidebar');
  assert.ok(host.inject.includes('sessionPersistence'));
  assert.deepEqual(readFileSync(join(installed, 'client.js')), readFileSync(join(installed, 'lib/client.js')));
  console.log('[package] NodeNext/Bundler consumer types, host import, client artifacts and archive contents verified');
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally { rmSync(temp, { recursive: true, force: true }); }
