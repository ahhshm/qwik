import { dirname } from 'path';
import { resolveMenu } from '../markdown/menu';
import type {
  BuildEntry,
  BuildLayout,
  BuildRoute,
  NormalizedPluginOptions,
  RouteSourceFile,
} from '../types';
import { createFileId, normalizePath } from '../utils/fs';
import { getPathnameFromDirPath, parseRouteIndexName } from './pathname';
import { parseRoutePathname } from './parse-pathname';
import { routeSortCompare } from './sort-routes';

export function resolveSourceFiles(opts: NormalizedPluginOptions, sourceFiles: RouteSourceFile[]) {
  const layouts = sourceFiles
    .filter((s) => s.type === 'layout')
    .map((s) => resolveLayout(opts, s))
    .sort((a, b) => {
      return a.id < b.id ? -1 : 1;
    });

  const routes = sourceFiles
    .filter((s) => s.type === 'route')
    .map((s) => resolveRoute(opts, layouts, s))
    .sort(routeSortCompare);

  const errors = sourceFiles
    .filter((s) => s.type === 'error')
    .map((s) => resolveError(opts, layouts, s))
    .filter((s) => s)
    .sort(routeSortCompare);

  const entries = sourceFiles
    .filter((s) => s.type === 'entry')
    .map((s) => resolveEntry(opts, s))
    .sort((a, b) => {
      return a.chunkFileName < b.chunkFileName ? -1 : 1;
    });

  const serviceWorkers = sourceFiles
    .filter((s) => s.type === 'service-worker')
    .map((p) => resolveServiceWorkerEntry(opts, p))
    .sort((a, b) => {
      return a.chunkFileName < b.chunkFileName ? -1 : 1;
    });

  const menus = sourceFiles
    .filter((s) => s.type === 'menu')
    .map((p) => resolveMenu(opts, p))
    .sort((a, b) => {
      return a.pathname < b.pathname ? -1 : 1;
    });

  let inc = 0;
  const ids = new Set<string>();
  const uniqueIds = (b: { id: string }[]) => {
    for (const r of b) {
      let id = r.id;
      while (ids.has(id)) {
        id = `${r.id}_${inc++}`;
      }
      r.id = id;
      ids.add(id);
    }
  };

  uniqueIds(layouts);
  uniqueIds(routes);
  uniqueIds(errors);
  uniqueIds(entries);
  uniqueIds(serviceWorkers);

  return { layouts, routes, errors, entries, menus, serviceWorkers };
}

export function resolveLayout(opts: NormalizedPluginOptions, layoutSourceFile: RouteSourceFile) {
  let extlessName = layoutSourceFile.extlessName;
  const filePath = layoutSourceFile.filePath;
  const dirPath = layoutSourceFile.dirPath;

  let layoutName: string;
  let layoutType: 'nested' | 'top';

  if (extlessName.endsWith(LAYOUT_TOP_SUFFIX)) {
    layoutType = 'top';
    extlessName = extlessName.slice(0, extlessName.length - 1);
  } else {
    layoutType = 'nested';
  }

  if (extlessName.startsWith(LAYOUT_NAMED_PREFIX)) {
    layoutName = extlessName.slice(LAYOUT_NAMED_PREFIX.length);
  } else {
    layoutName = '';
  }

  const layout: BuildLayout = {
    id: createFileId(opts.routesDir, filePath),
    filePath,
    dirPath,
    layoutType,
    layoutName,
  };

  return layout;
}

const LAYOUT_ID = 'layout';
const LAYOUT_NAMED_PREFIX = LAYOUT_ID + '-';
const LAYOUT_TOP_SUFFIX = '!';

export function resolveRoute(
  opts: NormalizedPluginOptions,
  appLayouts: BuildLayout[],
  sourceFile: RouteSourceFile
) {
  const filePath = sourceFile.filePath;
  const layouts: BuildLayout[] = [];
  const routesDir = opts.routesDir;
  const { layoutName, layoutStop } = parseRouteIndexName(sourceFile.extlessName);
  const pathname = getPathnameFromDirPath(opts, sourceFile.dirPath);

  if (!layoutStop) {
    let currentDir = normalizePath(dirname(filePath));
    let hasFoundNamedLayout = false;
    const hasNamedLayout = layoutName !== '';

    for (let i = 0; i < 20; i++) {
      let layout: BuildLayout | undefined = undefined;

      if (hasNamedLayout && !hasFoundNamedLayout) {
        layout = appLayouts.find((l) => l.dirPath === currentDir && l.layoutName === layoutName);
        if (layout) {
          hasFoundNamedLayout = true;
        }
      } else {
        layout = appLayouts.find((l) => l.dirPath === currentDir && l.layoutName === '');
      }

      if (layout) {
        layouts.push(layout);
        if (layout.layoutType === 'top') {
          break;
        }
      }

      if (currentDir === routesDir) {
        break;
      }

      currentDir = normalizePath(dirname(currentDir));
    }
  }

  const buildRoute: BuildRoute = {
    id: createFileId(opts.routesDir, filePath),
    filePath,
    pathname,
    layouts: layouts.reverse(),
    ext: sourceFile.ext,
    ...parseRoutePathname(pathname),
  };

  return buildRoute;
}

export function resolveError(
  opts: NormalizedPluginOptions,
  appLayouts: BuildLayout[],
  sourceFile: RouteSourceFile
) {
  return resolveRoute(opts, appLayouts, sourceFile);
}

function resolveEntry(opts: NormalizedPluginOptions, sourceFile: RouteSourceFile) {
  const pathname = getPathnameFromDirPath(opts, sourceFile.dirPath);
  const chunkFileName = pathname.slice(1);

  const buildEntry: BuildEntry = {
    id: createFileId(opts.routesDir, sourceFile.filePath),
    filePath: sourceFile.filePath,
    chunkFileName,
  };

  return buildEntry;
}

function resolveServiceWorkerEntry(opts: NormalizedPluginOptions, sourceFile: RouteSourceFile) {
  const pathname = getPathnameFromDirPath(opts, sourceFile.dirPath);
  const chunkFileName = pathname.slice(1) + sourceFile.extlessName + '.js';

  const buildEntry: BuildEntry = {
    id: createFileId(opts.routesDir, sourceFile.filePath),
    filePath: sourceFile.filePath,
    chunkFileName,
  };

  return buildEntry;
}
