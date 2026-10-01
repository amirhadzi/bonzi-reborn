import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { disallowedPreloadRequires, findRequires, formatBytes, parseBuildArgs } from '../scripts/lib/build-utils.ts';
import { BAD_KEY, startMockServer } from '../scripts/mock-openai.mjs';

const root = join(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

interface BuilderConfig {
  appId?: string;
  productName?: string;
  asar?: boolean;
  files?: unknown;
  publish?: unknown;
  electronFuses?: Record<string, boolean>;
  extraResources?: Array<{ from: string; to: string; filter?: string[] }>;
  directories?: { output?: string; buildResources?: string };
  win?: { target?: Array<{ target: string; arch: string[] }>; icon?: string; executableName?: string; signAndEditExecutable?: boolean; requestedExecutionLevel?: string };
  nsis?: Record<string, unknown>;
  portable?: Record<string, unknown>;
}

interface ConfigModule {
  getConfig(projectDir: string, configPath: string | null, configFromOptions: null): Promise<BuilderConfig>;
  validateConfiguration(config: BuilderConfig, debugLogger: unknown): Promise<void>;
}

describe('build flags', () => {
  it('defaults to a development build with source maps', () => {
    expect(parseBuildArgs([])).toEqual({ minify: false, sourcemap: true, watch: false });
  });
  it('turns source maps off for minified builds unless asked', () => {
    expect(parseBuildArgs(['--minify'])).toEqual({ minify: true, sourcemap: false, watch: false });
    expect(parseBuildArgs(['--minify', '--sourcemap']).sourcemap).toBe(true);
    expect(parseBuildArgs(['--no-sourcemap', '--watch'])).toEqual({ minify: false, sourcemap: false, watch: true });
  });
  it('rejects unknown flags', () => {
    expect(() => parseBuildArgs(['--prod'])).toThrow(/--prod/);
  });
});

describe('preload require check', () => {
  it('finds literal and dynamic requires', () => {
    const code = `var e = require("electron"); const f = require('node:fs'); require(\`events\`); x.require("no"); require(name);`;
    expect(findRequires(code)).toEqual(['electron', 'node:fs', 'events', '<dynamic>']);
  });
  it('accepts bundles that only require electron', () => {
    const esbuildOutput = `"use strict";\nvar import_electron = require("electron");\nimport_electron.contextBridge.exposeInMainWorld("bonzi", {});\n`;
    expect(disallowedPreloadRequires(esbuildOutput)).toEqual([]);
    expect(disallowedPreloadRequires(`var a=require("electron"),b=require("path");`)).toEqual(['path']);
  });
  it('ignores esbuild require shims that are not calls', () => {
    const shim = `var __require = ((x) => typeof require !== "undefined" ? require : x)(function(x) { if (typeof require !== "undefined") return require.apply(this, arguments); });`;
    expect(findRequires(shim)).toEqual([]);
  });
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.00 MB');
  });
});

describe('electron-builder.yml', () => {
  it('passes the electron-builder schema and has the required settings', async () => {
    const cfg = require(join(root, 'node_modules/app-builder-lib/out/util/config/config.js')) as ConfigModule;
    const { DebugLogger } = require(join(root, 'node_modules/builder-util/out/DebugLogger.js')) as {
      DebugLogger: new (enabled: boolean) => unknown;
    };
    const config = await cfg.getConfig(root, null, null);
    await cfg.validateConfiguration(config, new DebugLogger(false));

    expect(config.appId).toBe('io.github.amirhadzi.bonzireborn');
    expect(config.productName).toBe('BonziBuddy Reborn');
    expect(config.asar).toBe(true);
    expect(config.publish).toBeNull();
    expect(config.directories).toEqual({ output: 'release', buildResources: 'build' });
    // getConfig normalises the files list into a filter set.
    expect(config.files).toEqual([{ filter: ['dist/**/*', 'package.json', '!**/*.map'] }]);
    expect(config.electronFuses).toEqual({
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false,
      loadBrowserProcessSpecificV8Snapshot: false,
    });
    expect(config.extraResources).toEqual([
      { from: 'assets/characters', to: 'characters', filter: ['**/*.acs'] },
      { from: 'build/icon.ico', to: 'icon.ico' },
    ]);
    expect(config.win?.target).toEqual([
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ]);
    expect(config.win?.executableName).toBe('BonziBuddyReborn');
    expect(config.win?.requestedExecutionLevel).toBe('asInvoker');
    expect(config.win?.signAndEditExecutable).toBeUndefined();
    expect(config.nsis?.oneClick).toBe(false);
    expect(config.nsis?.perMachine).toBe(false);
    expect(String(config.nsis?.artifactName)).not.toMatch(/\s/);
    expect(String(config.portable?.artifactName)).not.toMatch(/\s/);
  });

  it('removes the Start with Windows Run entry on uninstall, keyed by the same id the app uses', async () => {
    const cfg = require(join(root, 'node_modules/app-builder-lib/out/util/config/config.js')) as ConfigModule;
    const config = await cfg.getConfig(root, null, null);
    expect(config.nsis?.include).toBe('build/installer.nsh');

    const nsh = readFileSync(join(root, 'build/installer.nsh'), 'utf8');
    expect(nsh).toContain('!macro customUnInstall');
    expect(nsh).toContain('!macroend');
    // Upgrades run the old uninstaller with --updated; the setting must survive those.
    expect(nsh).toMatch(/\$\{ifNot\}\s+\$\{isUpdated\}/);
    expect(nsh).toContain('DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "${APP_ID}"');
    expect(nsh).toContain(
      'DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run" "${APP_ID}"',
    );
    expect(nsh).not.toContain(String.fromCharCode(0x2014));

    // electron-builder defines ${APP_ID} from appId. Electron names the Run value after the
    // AppUserModelId (setLoginItemSettings is called without a name), so the two must match.
    const mainSrc = readFileSync(join(root, 'src/main/main.ts'), 'utf8');
    const aumid = /app\.setAppUserModelId\(\s*['"]([^'"]+)['"]\s*\)/.exec(mainSrc)?.[1];
    expect(aumid).toBe(config.appId);
    const loginSrc = readFileSync(join(root, 'src/main/login-item.ts'), 'utf8');
    const call = /setLoginItemSettings\(([^)]*)\)/.exec(loginSrc)?.[1];
    expect(call).toBeDefined();
    expect(call).not.toMatch(/\bname\s*:/);
  });
});

describe('package.json', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    main: string;
    type: string;
    engines?: { node?: string };
    scripts: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  it('points at the bundled main process and has no runtime dependencies', () => {
    expect(pkg.main).toBe('dist/main/main.cjs');
    expect(pkg.type).toBe('module');
    expect(pkg.engines?.node).toBe('>=24');
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });
  it('has the expected scripts', () => {
    for (const name of ['build', 'start', 'dev', 'typecheck', 'test', 'dist', 'icon', 'e2e', 'harness', 'mock:openai', 'acs:dump']) {
      expect(pkg.scripts[name], name).toBeTypeOf('string');
    }
    expect(pkg.scripts.dist).toContain('--minify');
    expect(pkg.scripts.dist).toContain('--publish never');
  });
});

describe('mock-openai type declarations', () => {
  it('match the module at runtime', async () => {
    expect(BAD_KEY).toBe('sk-bad');
    const mock = await startMockServer({ port: 0, log: false, chunkDelayMs: [0, 1] });
    try {
      expect(mock.baseURL).toBe(`${mock.url}/v1`);
      const res = await fetch(`${mock.baseURL}/models`, { headers: { authorization: 'Bearer sk-test-local' } });
      expect(res.status).toBe(200);
      expect(mock.requests[0]?.path).toBe('/v1/models');
      expect(mock.requests[0]?.hasAuth).toBe(true);
      expect(mock.reset()).toBe(1);
    } finally {
      await mock.close();
    }
  });
});
