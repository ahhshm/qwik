import type { NormalizedPluginOptions, BuildContext, PluginOptions } from '../types';
import { isAbsolute, resolve } from 'path';
import { normalizePath } from './fs';

export function createBuildContext(
  rootDir: string,
  userOpts?: PluginOptions,
  target?: 'ssr' | 'client'
) {
  const ctx: BuildContext = {
    rootDir: normalizePath(rootDir),
    opts: normalizeOptions(rootDir, userOpts),
    routes: [],
    errors: [],
    layouts: [],
    entries: [],
    serviceWorkers: [],
    menus: [],
    diagnostics: [],
    frontmatter: new Map(),
    target: target || 'ssr',
    isDevServer: false,
    isDevServerClientOnly: false,
    isDirty: true,
  };
  return ctx;
}

export function resetBuildContext(ctx: BuildContext | null) {
  if (ctx) {
    ctx.routes.length = 0;
    ctx.errors.length = 0;
    ctx.layouts.length = 0;
    ctx.entries.length = 0;
    ctx.menus.length = 0;
    ctx.diagnostics.length = 0;
    ctx.frontmatter.clear();
    ctx.isDirty = true;
  }
}

function normalizeOptions(rootDir: string, userOpts: PluginOptions | undefined) {
  const opts: NormalizedPluginOptions = { ...userOpts } as any;

  if (typeof opts.routesDir !== 'string') {
    opts.routesDir = resolve(rootDir, 'src', 'routes');
  } else if (!isAbsolute(opts.routesDir)) {
    opts.routesDir = resolve(rootDir, opts.routesDir);
  }
  opts.routesDir = normalizePath(opts.routesDir);

  if (typeof opts.baseUrl !== 'string') {
    opts.baseUrl = '/';
  } else {
    const url = new URL(opts.baseUrl, 'https://qwik.builer.io/');
    opts.baseUrl = url.pathname;
    if (!opts.baseUrl.endsWith('/')) {
      opts.baseUrl += '/';
    }
  }

  if (typeof opts.trailingSlash !== 'boolean') {
    opts.trailingSlash = false;
  }

  opts.mdx = opts.mdx || {};

  return opts;
}
