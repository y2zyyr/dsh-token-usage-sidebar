// scripts/build.mjs
import { build } from 'esbuild';
import ts from 'typescript';
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
    define: { __DTSU_PLUGIN_VERSION__: JSON.stringify(packageJson.version) },
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

  // esbuild strips types; TypeScript emits self-contained declarations.
  const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames, {
    ...parsed.options, noEmit: false, declaration: true, emitDeclarationOnly: true,
    noEmitOnError: true, rootDir: join(root, 'src'), outDir: join(root, 'lib', 'types'),
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (name) => name, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
  const emitted = program.emit(undefined, (path, text) => {
    // Published NodeNext declarations resolve sibling .d.ts files via .js.
    const normalized = text.replace(/(from\s+['"][^'"]+|import\(['"][^'"]+)\.tsx?(['"])/g, '$1.js$2');
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, normalized);
  });
  if (emitted.emitSkipped) throw new Error('[build] declaration emission failed');

  console.log('[build] host ->', join(root, 'lib', 'index.js'));
  console.log('[build] client ->', join(root, 'lib', 'client.js'), '(' + Buffer.byteLength(wrapped) + ' bytes)');
  console.log('[build] client compat ->', join(root, 'client.js'));
}
main().catch((e) => { console.error('[build] failed', e); process.exit(1); });
