import type { BuildContext, RouteSourceFile, RouteSourceFileName, RouteSourceType } from '../types';
import { addError } from '../utils/format';
import {
  isModuleExt,
  isEntryName,
  isErrorName,
  isMarkdownExt,
  isMenuFileName,
  isPageModuleExt,
  isServiceWorkerName,
  getExtension,
  removeExtension,
} from '../utils/fs';

export function getSourceFile(fileName: string) {
  const ext = getExtension(fileName);
  const extlessName = removeExtension(fileName);
  const isPageModule = isPageModuleExt(ext);
  const isModule = isModuleExt(ext);
  const isMarkdown = isMarkdownExt(ext);
  let type: RouteSourceType | null = null;

  if (extlessName.startsWith('index') && (isPageModule || isModule || isMarkdown)) {
    // route page or endpoint
    // index@layoutname or index! - ts|tsx|js|jsx|md|mdx
    type = 'route';
  } else if (extlessName.startsWith('layout') && (isPageModule || isModule)) {
    // layout-name or layout! - ts|tsx|js|jsx
    type = 'layout';
  } else if (isEntryName(extlessName) && isModule) {
    // entry module - ts|js
    type = 'entry';
  } else if (isErrorName(extlessName) && (isPageModule || isMarkdown)) {
    // 404 or 500 - ts|tsx|js|jsx|md|mdx
    type = 'error';
  } else if (isMenuFileName(fileName)) {
    // menu.md
    type = 'menu';
  } else if (isModule && isServiceWorkerName(extlessName)) {
    // service-worker.ts|js
    type = 'service-worker';
  }

  if (type !== null) {
    const sourceFileName: RouteSourceFileName = {
      type,
      extlessName,
      ext,
    };
    return sourceFileName;
  }

  return null;
}

export function validateSourceFiles(ctx: BuildContext, sourceFiles: RouteSourceFile[]) {
  for (const sourceFile of sourceFiles) {
    const err = validateSourceFile(sourceFile);
    if (err) {
      addError(ctx, err);
    }
  }
}

function validateSourceFile(sourceFile: RouteSourceFile) {
  // if (isTestDirName(sourceFile.dirName)) {
  //   return `Test directory "${sourceFile.filePath}" should not be included within the routes directory. Please move test directories to a different location.`;
  // }

  // if (isTestFileName(sourceFile.fileName)) {
  //   return `Test file "${sourceFile.filePath}" should not be included within the routes directory. Please move test files to a different location.`;
  // }

  // if (sourceFile.dirName.includes('@')) {
  //   return `Route directories cannot have a named layout. Please change the named layout from the directory "${sourceFile.dirPath}" to a file.`;
  // }

  return null;
}
