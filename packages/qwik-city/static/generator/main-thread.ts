import type { StaticGeneratorOptions, StaticGeneratorResults, StaticRoute, System } from './types';
import { getPathnameForDynamicRoute, msToString, normalizePathname } from './utils';
import type { PageModule, RouteParams } from '../../runtime/src/library/types';
import { routes } from '@qwik-city-plan';

export async function mainThread(sys: System) {
  const opts = sys.getOptions();
  validateOptions(opts);

  const main = await sys.createMainProcess();
  const log = await sys.createLogger();
  const queue: StaticRoute[] = [];
  const active = new Set<string>();

  return new Promise<StaticGeneratorResults>((resolve, reject) => {
    try {
      const timer = sys.createTimer();
      const generatorResults: StaticGeneratorResults = {
        duration: 0,
        rendered: 0,
        errors: 0,
      };

      let isCompleted = false;
      let isRoutesLoaded = false;

      const next = () => {
        while (!isCompleted && main.hasAvailableWorker() && queue.length > 0) {
          const staticRoute = queue.shift();
          if (staticRoute) {
            render(staticRoute);
          }
        }

        if (!isCompleted && isRoutesLoaded && queue.length === 0 && active.size === 0) {
          isCompleted = true;

          generatorResults.duration = timer();

          log.info(
            `Rendered: ${generatorResults.rendered} page${
              generatorResults.rendered === 1 ? '' : 's'
            }`
          );

          log.info(`Duration: ${msToString(generatorResults.duration)}`);

          if (generatorResults.rendered > 0) {
            log.info(
              `Average: ${msToString(
                generatorResults.duration / generatorResults.rendered
              )} per page`
            );
          }

          if (generatorResults.errors > 0) {
            log.info(`errors: ${generatorResults.errors}`);
          }

          main
            .close()
            .then(() => {
              setTimeout(() => resolve(generatorResults));
            })
            .catch(reject);
        }
      };

      let isPendingDrain = false;
      const flushQueue = () => {
        if (!isPendingDrain) {
          isPendingDrain = true;
          setTimeout(() => {
            isPendingDrain = false;
            next();
          });
        }
      };

      const render = async (staticRoute: StaticRoute) => {
        try {
          active.add(staticRoute.pathname);

          const result = await main.render({ type: 'render', ...staticRoute });

          active.delete(staticRoute.pathname);

          if (result.error) {
            log.error(staticRoute.pathname, result.error);
            generatorResults.errors++;
          } else if (result.ok) {
            generatorResults.rendered++;
            log.debug(`  ${staticRoute.pathname}`);
          }

          flushQueue();
        } catch (e) {
          isCompleted = true;
          reject(e);
        }
      };

      const addToQueue = (pathname: string | undefined | null, params: RouteParams | undefined) => {
        pathname = normalizePathname(opts, pathname);
        if (pathname && !queue.some((s) => s.pathname === pathname)) {
          queue.push({
            pathname,
            params,
          });
          flushQueue();
        }
      };

      const loadStaticRoutes = async () => {
        await Promise.all(
          routes.map(async (route) => {
            const [_, loaders, paramNames, originalPathname] = route;
            const modules = await Promise.all(loaders.map((loader) => loader()));
            const pageModule: PageModule = modules[modules.length - 1] as any;

            if (pageModule.default) {
              // page module (not an endpoint)

              if (Array.isArray(paramNames) && paramNames.length > 0) {
                if (typeof pageModule.onStaticGenerate === 'function' && paramNames.length > 0) {
                  // dynamic route page module
                  const staticGenerate = await pageModule.onStaticGenerate();
                  if (Array.isArray(staticGenerate.params)) {
                    for (const params of staticGenerate.params) {
                      const pathname = getPathnameForDynamicRoute(
                        originalPathname!,
                        paramNames,
                        params
                      );
                      addToQueue(pathname, params);
                    }
                  }
                }
              } else {
                // static route page module
                addToQueue(originalPathname, undefined);
              }
            }
          })
        );

        isRoutesLoaded = true;

        flushQueue();
      };

      loadStaticRoutes();
    } catch (e) {
      reject(e);
    }
  });
}

function validateOptions(opts: StaticGeneratorOptions) {
  let baseUrl = opts.baseUrl;
  if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
    throw new Error(`Missing "baseUrl" option`);
  }
  baseUrl = baseUrl.trim();
  if (!baseUrl.startsWith('https://') && !baseUrl.startsWith('http://')) {
    throw new Error(`"baseUrl" must start with a valid protocol, "https://" or "http://"`);
  }
  if (!opts.baseUrl.endsWith('/')) {
    throw new Error(`"baseUrl" option must end with a slash "/"`);
  }
}
