// scripts/build.mjs
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (typeof packageJson.name !== 'string' || packageJson.name.length === 0) {
  throw new Error('[build] package.json must define a non-empty name');
}
const PLUGIN_ID = packageJson.name;

const hostExternals = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-storage',
  'zod',
  'node:fs',
  'node:path',
  'node:os',
  'node:zlib',
  // v1.1 durable ledger: keep node:sqlite an external so the DSH host resolves
  // the built-in binding directly (no bundling of a native addon shim).
  'node:sqlite',
  'node:crypto',
];
const clientExternals = [
  'react',
  'react/jsx-runtime',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
];

async function main() {
  mkdirSync(join(root, 'lib'), { recursive: true });

  // 1) Host bundle (ESM)
  await build({
    entryPoints: [join(root, 'src', 'index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    external: hostExternals,
    outfile: join(root, 'lib', 'index.js'),
    sourcemap: false,
    logLevel: 'silent',
  });

  // 2) Client bundle (IIFE setting a global the loader wrapper reads)
  const result = await build({
    entryPoints: [join(root, 'src', 'client', '_entry.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    external: clientExternals,
    sourcemap: false,
    logLevel: 'silent',
    write: false,
  });
  const body = result.outputFiles[0].text;

  const wrapped = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(PLUGIN_ID)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body}
		var entry = self.__dsh_token_usage_sidebar_entry__;
		module.exports.apply = entry && entry.apply;
		module.exports.inject = entry && entry.inject;
		return module.exports;
	}
});
`;

  writeFileSync(join(root, 'lib', 'client.js'), wrapped);
  // Some DSH CLI web profiles resolve the browser module from the package
  // root. Keep that compatibility artifact byte-for-byte aligned with lib/.
  writeFileSync(join(root, 'client.js'), wrapped);

  mkdirSync(join(root, 'lib', 'types'), { recursive: true });
  mkdirSync(join(root, 'lib', 'types', 'client'), { recursive: true });
  writeFileSync(join(root, 'lib', 'types', 'index.d.ts'), `export * from '../../src/index';`);
  writeFileSync(join(root, 'lib', 'types', 'client', 'index.d.ts'), `export * from '../../../src/client/index';`);

  console.log('[build] host ->', join(root, 'lib', 'index.js'));
  console.log('[build] client ->', join(root, 'lib', 'client.js'), '(' + Buffer.byteLength(wrapped) + ' bytes)');
  console.log('[build] client compat ->', join(root, 'client.js'));
}
main().catch((e) => { console.error('[build] failed', e); process.exit(1); });
