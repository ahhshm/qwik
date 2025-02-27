import type { Transformer } from 'unified';
import Slugger from 'github-slugger';
import type { Root } from 'mdast';
import type { MdxjsEsm } from 'mdast-util-mdx';
import { valueToEstree } from 'estree-util-value-to-estree';
import { headingRank } from 'hast-util-heading-rank';
import { toString } from 'hast-util-to-string';
import { visit } from 'unist-util-visit';
import type { ContentHeading } from '../../runtime/src';
import type { BuildContext, NormalizedPluginOptions } from '../types';
import { getExtension, isMarkdownExt, normalizePath } from '../utils/fs';
import { frontmatterAttrsToDocumentHead } from './frontmatter';
import { getMarkdownRelativeUrl, isSameOriginUrl } from '../routing/pathname';

export function rehypePage(ctx: BuildContext): Transformer {
  return (ast, vfile) => {
    const mdast = ast as Root;
    const sourcePath = normalizePath(vfile.path);

    updateContentLinks(mdast, ctx.opts, sourcePath);
    exportFrontmatter(ctx, mdast, sourcePath);
    exportContentHead(ctx, mdast, sourcePath);
    exportContentHeadings(mdast);
  };
}

function updateContentLinks(mdast: Root, opts: NormalizedPluginOptions, sourcePath: string) {
  visit(mdast, 'element', (node: any) => {
    const tagName = node && node.type === 'element' && node.tagName.toLowerCase();
    if (tagName === 'a') {
      const href = ((node.properties && node.properties.href) || '').trim();

      if (isSameOriginUrl(href)) {
        const ext = getExtension(href);

        if (isMarkdownExt(ext)) {
          node.properties.href = getMarkdownRelativeUrl(
            opts,
            sourcePath,
            node.properties.href,
            true
          );
        }
      }
    }
  });
}

function exportFrontmatter(ctx: BuildContext, mdast: Root, sourcePath: string) {
  const attrs = ctx.frontmatter.get(sourcePath);
  createExport(mdast, 'frontmatter', attrs);
}

function exportContentHead(ctx: BuildContext, mdast: Root, sourcePath: string) {
  const attrs = ctx.frontmatter.get(sourcePath);
  const head = frontmatterAttrsToDocumentHead(attrs);
  if (head) {
    createExport(mdast, 'head', head);
  }
}

function exportContentHeadings(mdast: Root) {
  const slugs = new Slugger();
  const headings: ContentHeading[] = [];

  visit(mdast, 'element', (node: any) => {
    const level = headingRank(node);
    if (level && node.properties && !hasProperty(node, 'id')) {
      const text = toString(node);
      const id = slugs.slug(text);
      node.properties.id = id;

      headings.push({
        text,
        id,
        level,
      });
    }
  });

  if (headings.length > 0) {
    createExport(mdast, 'headings', headings);
  }
}

function createExport(mdast: Root, identifierName: string, val: any) {
  const mdxjsEsm: MdxjsEsm = {
    type: 'mdxjsEsm',
    value: '',
    data: {
      estree: {
        type: 'Program',
        sourceType: 'module',
        body: [
          {
            type: 'ExportNamedDeclaration',
            source: null,
            specifiers: [],
            declaration: {
              type: 'VariableDeclaration',
              kind: 'const',
              declarations: [
                {
                  type: 'VariableDeclarator',
                  id: { type: 'Identifier', name: identifierName },
                  init: valueToEstree(val),
                },
              ],
            },
          },
        ],
      },
    },
  };
  mdast.children.unshift(mdxjsEsm);
}

const own = {}.hasOwnProperty;
function hasProperty(node: any, propName: string) {
  const value =
    propName &&
    node &&
    typeof node === 'object' &&
    node.type === 'element' &&
    node.properties &&
    own.call(node.properties, propName) &&
    node.properties[propName];
  return value != null && value !== false;
}
