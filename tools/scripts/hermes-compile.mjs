/**
 * Compiles every pure lib with the real Hermes compiler.
 *
 * For each project tagged runtime:universal, scope:contracts,
 * scope:country-pack, layer:domain or layer:application, this bundles
 * src/index.ts together with its npm dependencies and runs the bundle through
 * hermesc, the compiler React Native uses to build an app. If Hermes cannot parse the code, or a third-party
 * dependency ships syntax Hermes does not support, this fails here and not in
 * a mobile build months later.
 *
 * It complements the Jest "hermes" configuration (tools/jest): that one runs
 * the tests without Node's globals and modules, this one checks the syntax
 * with Hermes itself. Neither executes code on the Hermes engine, because npm
 * ships the compiler only. Tests on a device start with apps/mobile.
 *
 * Usage: node tools/scripts/hermes-compile.mjs
 * Exit code 0 means every lib compiled.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(ROOT, 'dist/hermes');
const PURE_TAGS = [
  'runtime:universal',
  'scope:contracts',
  'scope:country-pack',
  'layer:domain',
  'layer:application',
];
const SKIP_FOLDERS = new Set(['node_modules', 'dist', 'src']);

const posix = (path) => path.split('\\').join('/');

/** @returns {{ name: string, root: string }[]} */
function findPureProjects(folder = join(ROOT, 'libs')) {
  if (!existsSync(folder)) return [];
  const found = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_FOLDERS.has(entry.name)) found.push(...findPureProjects(path));
    } else if (entry.name === 'project.json') {
      const project = JSON.parse(readFileSync(path, 'utf8'));
      if ((project.tags ?? []).some((tag) => PURE_TAGS.includes(tag))) {
        found.push({ name: project.name, root: folder });
      }
    }
  }
  return found;
}

/** The @hk/* aliases from tsconfig.base.json, so libs can import each other. */
function workspaceAliases() {
  const tsconfig = JSON.parse(
    readFileSync(join(ROOT, 'tsconfig.base.json'), 'utf8'),
  );
  return Object.entries(tsconfig.compilerOptions.paths ?? {})
    .sort(([a], [b]) => b.length - a.length)
    .map(([alias, [target]]) => ({
      find: new RegExp(`^${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
      replacement: join(ROOT, target),
    }));
}

function findHermesc() {
  const folder = {
    win32: 'win64-bin',
    linux: 'linux64-bin',
    darwin: 'osx-bin',
  }[process.platform];
  if (!folder) {
    throw new Error(`No hermesc binary for platform ${process.platform}.`);
  }
  // hermes-compiler is a dependency of react-native, not of this workspace,
  // so it is resolved from react-native's location.
  const fromWorkspace = createRequire(join(ROOT, 'package.json'));
  const fromReactNative = createRequire(
    fromWorkspace.resolve('react-native/package.json'),
  );
  const compiler = dirname(
    fromReactNative.resolve('hermes-compiler/package.json'),
  );
  const binary = join(
    compiler,
    'hermesc',
    folder,
    process.platform === 'win32' ? 'hermesc.exe' : 'hermesc',
  );
  if (!existsSync(binary)) {
    throw new Error(`hermesc not found at ${binary}.`);
  }
  return binary;
}

async function compile(project, hermesc, alias) {
  const entry = join(project.root, 'src/index.ts');
  const outDir = join(OUT, project.name);
  await build({
    configFile: false,
    logLevel: 'error',
    root: ROOT,
    resolve: { alias },
    build: {
      lib: { entry, formats: ['cjs'], fileName: () => 'bundle.js' },
      outDir,
      emptyOutDir: true,
      minify: false,
      // esnext = rewrite nothing. A lower target makes the bundler turn newer
      // syntax into runtime calls that hermesc cannot check.
      target: 'esnext',
    },
  });
  const result = spawnSync(
    hermesc,
    [
      '-emit-binary',
      '-out',
      join(outDir, 'bundle.hbc'),
      join(outDir, 'bundle.js'),
    ],
    { encoding: 'utf8' },
  );
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  };
}

async function main() {
  const projects = findPureProjects();
  if (projects.length === 0) {
    console.log('No pure libs to compile.');
    return 0;
  }
  const hermesc = findHermesc();
  const alias = workspaceAliases();
  rmSync(OUT, { recursive: true, force: true });

  let failed = 0;
  for (const project of projects) {
    const label = `${project.name} (${posix(relative(ROOT, project.root))})`;
    try {
      const result = await compile(project, hermesc, alias);
      if (result.ok) {
        console.log(`ok      ${label}`);
      } else {
        failed += 1;
        console.error(`FAILED  ${label}\n${result.output}`);
      }
    } catch (error) {
      failed += 1;
      console.error(`FAILED  ${label}\n${error?.message ?? error}`);
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} lib(s) do not compile with Hermes.`);
    return 1;
  }
  console.log(`\nAll ${projects.length} pure lib(s) compile with Hermes.`);
  return 0;
}

process.exitCode = await main();
