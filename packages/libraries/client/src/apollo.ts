import { createHash } from 'node:crypto';
import axios from 'axios';
import type { DocumentNode } from 'graphql';
import type { ApolloServerPlugin, HTTPGraphQLRequest } from '@apollo/server';
import { autoDisposeSymbol, createHive } from './client.js';
import type {
  HiveClient,
  HivePluginOptions,
  SupergraphSDLFetcherOptions,
} from './internal/types.js';
import { isHiveClient, joinUrl } from './internal/utils.js';
import { version } from './version.js';

export function createSupergraphSDLFetcher(options: SupergraphSDLFetcherOptions) {
  let cacheETag: string | null = null;
  let cached: {
    id: string;
    supergraphSdl: string;
  } | null = null;
  const endpoint = options.endpoint.endsWith('/supergraph')
    ? options.endpoint
    : joinUrl(options.endpoint, 'supergraph');

  return function supergraphSDLFetcher() {
    const headers: {
      [key: string]: string;
    } = {
      'X-Hive-CDN-Key': options.key,
      'User-Agent': `hive-client/${version}`,
    };

    if (cacheETag) {
      headers['If-None-Match'] = cacheETag;
    }

    let retryCount = 0;

    const retry = (status: number) => {
      if (retryCount >= 10 || status < 499) {
        return Promise.reject(new Error(`Failed to fetch [${status}]`));
      }

      retryCount = retryCount + 1;

      return fetchWithRetry();
    };

    const fetchWithRetry = (): Promise<{ id: string; supergraphSdl: string }> => {
      return axios
        .get(endpoint, {
          headers,
        })
        .then(response => {
          if (response.status >= 200 && response.status < 300) {
            const supergraphSdl = response.data;
            const result = {
              id: createHash('sha256').update(supergraphSdl).digest('base64'),
              supergraphSdl,
            };

            const etag = response.headers['etag'];
            if (etag) {
              cached = result;
              cacheETag = etag;
            }

            return result;
          }

          return retry(response.status);
        })
        .catch(async error => {
          if (axios.isAxiosError(error)) {
            if (error.response?.status === 304 && cached !== null) {
              return cached;
            }

            if (error.response?.status) {
              return retry(error.response.status);
            }
          }

          throw error;
        });
    };

    return fetchWithRetry();
  };
}

export function createSupergraphManager(
  options: { pollIntervalInMs?: number } & SupergraphSDLFetcherOptions,
) {
  const pollIntervalInMs = options.pollIntervalInMs ?? 30_000;
  const fetchSupergraph = createSupergraphSDLFetcher({
    endpoint: options.endpoint,
    key: options.key,
  });
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    async initialize(hooks: { update(supergraphSdl: string): void }): Promise<{
      supergraphSdl: string;
      cleanup?: () => Promise<void>;
    }> {
      const initialResult = await fetchSupergraph();

      function poll() {
        timer = setTimeout(async () => {
          try {
            const result = await fetchSupergraph();
            if (result.supergraphSdl) {
              hooks.update?.(result.supergraphSdl);
            }
          } catch (error) {
            console.error(
              `Failed to update supergraph: ${error instanceof Error ? error.message : error}`,
            );
          }
          poll();
        }, pollIntervalInMs);
      }

      poll();

      return {
        supergraphSdl: initialResult.supergraphSdl,
        cleanup: async () => {
          if (timer) {
            clearTimeout(timer);
          }
        },
      };
    },
  };
}

function addRequestWithHeaders(context: any, http?: HTTPGraphQLRequest) {
  if (!!http && !('request' in context)) {
    context.request = {
      headers: http.headers,
    };
  }

  return context;
}

export function hiveApollo(clientOrOptions: HiveClient | HivePluginOptions): ApolloServerPlugin {
  const hive = isHiveClient(clientOrOptions)
    ? clientOrOptions
    : createHive({
        ...clientOrOptions,
        agent: {
          name: 'hive-client-apollo',
          ...clientOrOptions.agent,
        },
      });

  void hive.info();

  return {
    requestDidStart(context) {
      // `overallCachePolicy` does not exist in v0
      const isLegacyV0 = !('overallCachePolicy' in context);
      // `context` does not exist in v4, it is `contextValue` instead
      const isLegacyV3 = 'context' in context;

      let doc: DocumentNode;
      let didResolveSource = false;
      const complete = hive.collectUsage();
      const args = {
        schema: context.schema,
        get document() {
          return doc;
        },
        operationName: context.operationName,
        contextValue: addRequestWithHeaders(
          isLegacyV3 ? context.context : context.contextValue,
          context.request?.http,
        ),
        variableValues: context.request.variables,
      };

      if (isLegacyV0) {
        return {
          didResolveSource() {
            didResolveSource = true;
          },
          willSendResponse(ctx: any) {
            if (!didResolveSource) {
              complete(args, {
                action: 'abort',
                reason: 'Did not resolve source',
                logging: false,
              });
              return;
            }
            doc = ctx.document;
            complete(args, ctx.response);
          },
        } as any;
      }

      if (isLegacyV3) {
        return Promise.resolve({
          didResolveSource() {
            didResolveSource = true;
          },
          async willSendResponse(ctx) {
            if (!didResolveSource) {
              complete(args, {
                action: 'abort',
                reason: 'Did not resolve source',
                logging: false,
              });
              return;
            }

            if (!ctx.document) {
              const details = ctx.operationName ? `operationName: ${ctx.operationName}` : '';
              complete(args, {
                action: 'abort',
                reason: 'Document is not available' + (details ? ` (${details})` : ''),
                logging: true,
              });
              return;
            }

            doc = ctx.document!;
            complete(args, ctx.response as any);
          },
        });
      }

      // v4
      return Promise.resolve({
        didResolveSource() {
          didResolveSource = true;
        },
        async willSendResponse(ctx) {
          if (!didResolveSource) {
            complete(args, {
              action: 'abort',
              reason: 'Did not resolve source',
              logging: false,
            });
            return;
          }

          if (!ctx.document) {
            const details = ctx.operationName ? `operationName: ${ctx.operationName}` : '';
            complete(args, {
              action: 'abort',
              reason: 'Document is not available' + (details ? ` (${details})` : ''),
              logging: true,
            });
            return;
          }

          doc = ctx.document;
          if (ctx.response.body.kind === 'incremental') {
            complete(args, {
              action: 'abort',
              reason: '@defer and @stream is not supported by Hive',
              logging: true,
            });
          } else {
            complete(args, ctx.response.body.singleResult);
          }
        },
      });
    },
    serverWillStart(ctx) {
      // `engine` does not exist in v3
      const isLegacyV0 = 'engine' in ctx;

      hive.reportSchema({ schema: ctx.schema });

      if (isLegacyV0) {
        return {
          async serverWillStop() {
            if (hive[autoDisposeSymbol]) {
              await hive.dispose();
            }
          },
        } as any;
      }

      // Works on v3 and v4

      return Promise.resolve({
        async serverWillStop() {
          if (hive[autoDisposeSymbol]) {
            await hive.dispose();
          }
        },
        schemaDidLoadOrUpdate(schemaContext) {
          if (ctx.schema !== schemaContext.apiSchema) {
            hive.reportSchema({ schema: schemaContext.apiSchema });
          }
        },
      });
    },
  };
}
