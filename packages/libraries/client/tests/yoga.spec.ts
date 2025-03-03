/* eslint import/no-extraneous-dependencies: ["error", {"devDependencies": true}] */
import { createServer } from 'node:http';
import axios from 'axios';
import { GraphQLError } from 'graphql';
import { createClient } from 'graphql-ws';
import { useServer as useWSServer } from 'graphql-ws/lib/use/ws';
import { createLogger, createSchema, createYoga } from 'graphql-yoga';
import nock from 'nock';
import { WebSocket, WebSocketServer } from 'ws';
import { useDeferStream } from '@graphql-yoga/plugin-defer-stream';
import { useDisableIntrospection } from '@graphql-yoga/plugin-disable-introspection';
import { useGraphQLSSE } from '@graphql-yoga/plugin-graphql-sse';
import { useResponseCache } from '@graphql-yoga/plugin-response-cache';
import { useHive } from '../src/yoga.js';

beforeAll(() => {
  nock.cleanAll();
});

it('reports usage', async ({ expect }) => {
  const graphqlScope = nock('http://localhost')
    .post('/usage', body => {
      expect(body.map).toMatchInlineSnapshot(`
        {
          0063ba7bf2695b896c464057aef29cdc: {
            fields: [
              Query.hi,
            ],
            operation: {hi},
            operationName: anonymous,
          },
        }
      `);

      return true;
    })
    .reply(200);
  const yoga = createYoga({
    schema: createSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          hi: String
        }
      `,
    }),
    plugins: [
      useHive({
        enabled: true,
        debug: false,
        token: 'brrrt',
        selfHosting: {
          applicationUrl: 'http://localhost/foo',
          graphqlEndpoint: 'http://localhost/graphql',
          usageEndpoint: 'http://localhost/usage',
        },
        usage: {
          endpoint: 'http://localhost/usage',
          clientInfo() {
            return {
              name: 'brrr',
              version: '1',
            };
          },
        },
        agent: {
          maxSize: 1,
          logger: createLogger('silent'),
        },
      }),
    ],
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      resolve();
    }, 1000);
    let requestCount = 0;

    graphqlScope.on('request', () => {
      requestCount = requestCount + 1;
      if (requestCount === 2) {
        clearTimeout(timeout);
        resolve();
      }
    });

    (async () => {
      const res = await yoga.fetch('http://localhost/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `{ hi }`,
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toMatchInlineSnapshot('{"data":{"hi":null}}');
    })().catch(reject);
  });

  graphqlScope.done();
});

it('reports usage with response cache', async ({ expect }) => {
  axios.interceptors.request.use(config => {
    return config;
  });
  let usageCount = 0;
  const graphqlScope = nock('http://localhost')
    .post('/usage', body => {
      usageCount++;
      expect(body.map).toMatchInlineSnapshot(`
        {
          0063ba7bf2695b896c464057aef29cdc: {
            fields: [
              Query.hi,
            ],
            operation: {hi},
            operationName: anonymous,
          },
        }
      `);

      return true;
    })
    .thrice()
    .reply(200);
  const yoga = createYoga({
    schema: createSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          hi: String
        }
      `,
    }),
    plugins: [
      useResponseCache({
        session: () => null,
        ttl: Infinity,
      }),
      useHive({
        enabled: true,
        debug: false,
        token: 'brrrt',
        selfHosting: {
          applicationUrl: 'http://localhost/foo',
          graphqlEndpoint: 'http://localhost/graphql',
          usageEndpoint: 'http://localhost/usage',
        },
        usage: {
          endpoint: 'http://localhost/usage',
          clientInfo() {
            return {
              name: 'brrr',
              version: '1',
            };
          },
        },
        agent: {
          maxSize: 1,
          logger: createLogger('silent'),
        },
      }),
    ],
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      resolve();
    }, 1000);
    let requestCount = 0;

    graphqlScope.on('request', () => {
      requestCount = requestCount + 1;
      if (requestCount === 4) {
        clearTimeout(timeout);
        resolve();
      }
    });

    (async () => {
      for (const _ of [1, 2, 3]) {
        const res = await yoga.fetch('http://localhost/graphql', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query: `{ hi }`,
          }),
        });
        expect(res.status).toBe(200);
        expect(await res.text()).toEqual('{"data":{"hi":null}}');
      }
    })().catch(reject);
  });
  expect(usageCount).toBe(3);
  graphqlScope.done();
});

it('does not report usage for operation that does not pass validation', async ({ expect }) => {
  const callback = vi.fn();
  const yoga = createYoga({
    schema: createSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          hi: String
        }
      `,
    }),
    plugins: [
      useDisableIntrospection(),
      useHive({
        enabled: true,
        debug: false,
        token: 'brrrt',
        selfHosting: {
          applicationUrl: 'http://localhost/foo',
          graphqlEndpoint: 'http://localhost/graphql',
          usageEndpoint: 'http://localhost/usage',
        },
        usage: {
          endpoint: 'http://localhost/usage',
          clientInfo() {
            return {
              name: 'brrr',
              version: '1',
            };
          },
        },
        agent: {
          maxSize: 1,
          logger: createLogger('silent'),
        },
      }),
    ],
  });

  await new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      resolve();
    }, 1000);
    nock.emitter.once('no match', (req: any) => {
      reject(new Error(`Unexpected request was sent to ${req.path}`));
    });

    (async () => {
      const res = await yoga.fetch('http://localhost/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: /* GraphQL */ `
            {
              __schema {
                types {
                  name
                }
              }
            }
          `,
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toContain('GraphQL introspection has been disabled');
    })().catch(reject);
  });
  expect(callback).not.toHaveBeenCalled();
});

it('does not report usage if context creating raises an error', async ({ expect }) => {
  const callback = vi.fn();

  const yoga = createYoga({
    schema: createSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          hi: String
        }
      `,
    }),
    plugins: [
      {
        onContextBuilding() {
          throw new GraphQLError('Not authenticated.');
        },
      },
      useHive({
        enabled: true,
        debug: false,
        token: 'brrrt',
        selfHosting: {
          applicationUrl: 'http://localhost/foo',
          graphqlEndpoint: 'http://localhost/graphql',
          usageEndpoint: 'http://localhost/usage',
        },
        usage: {
          endpoint: 'http://localhost/usage',
          clientInfo() {
            return {
              name: 'brrr',
              version: '1',
            };
          },
        },
        agent: {
          maxSize: 1,
          logger: createLogger('silent'),
        },
      }),
    ],
  });

  // eslint-disable-next-line no-async-promise-executor
  await new Promise<void>((resolve, reject) => {
    nock.emitter.once('no match', (req: any) => {
      reject(new Error(`Unexpected request was sent to ${req.path}`));
    });

    setTimeout(() => {
      resolve();
    }, 1000);

    (async () => {
      const res = await yoga.fetch('http://localhost/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: /* GraphQL */ `
            {
              hi
            }
          `,
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toMatchInlineSnapshot(
        `{"errors":[{"message":"Not authenticated."}]}`,
      );
    })().catch(reject);
  });

  expect(callback).not.toHaveBeenCalled();
});

describe('subscription usage reporting', () => {
  describe('built-in see', () => {
    it('reports usage for successful subscription operation', async ({ expect }) => {
      const graphqlScope = nock('http://localhost')
        .post('/usage', body => {
          expect(body.map).toEqual({
            c6cc5505189a301dcadc408034c21a2d: {
              fields: ['Subscription.hi'],
              operation: 'subscription{hi}',
              operationName: 'anonymous',
            },
          });

          expect(body.operations).toBeUndefined();
          expect(body.subscriptionOperations).toMatchObject([
            {
              operationMapKey: 'c6cc5505189a301dcadc408034c21a2d',
              metadata: {
                client: {
                  name: 'brrr',
                  version: '1',
                },
              },
            },
          ]);

          return true;
        })
        .reply(200);

      const yoga = createYoga({
        logging: false,
        schema: createSchema({
          typeDefs: /* GraphQL */ `
            type Query {
              hii: String
            }

            type Subscription {
              hi: String
            }
          `,
          resolvers: {
            Subscription: {
              hi: {
                /* eslint-disable-next-line require-yield */
                async *subscribe() {
                  return;
                },
              },
            },
          },
        }),
        plugins: [
          useDisableIntrospection(),
          useHive({
            enabled: true,
            debug: false,
            token: 'brrrt',
            selfHosting: {
              applicationUrl: 'http://localhost/foo',
              graphqlEndpoint: 'http://localhost/graphql',
              usageEndpoint: 'http://localhost/usage',
            },
            usage: {
              endpoint: 'http://localhost/usage',
              clientInfo() {
                return {
                  name: 'brrr',
                  version: '1',
                };
              },
            },
            agent: {
              maxSize: 1,
              logger: createLogger('silent'),
            },
          }),
        ],
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          resolve();
        }, 1000);
        let requestCount = 0;

        graphqlScope.on('request', () => {
          requestCount = requestCount + 1;
          if (requestCount === 2) {
            clearTimeout(timeout);
            resolve();
          }
        });

        (async () => {
          const res = await yoga.fetch('http://localhost/graphql', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              query: `subscription { hi }`,
            }),
          });
          expect(res.status).toBe(200);
          expect(await res.text()).toMatchInlineSnapshot(`
          :

          event: complete
        `);
        })().catch(reject);
      });
      graphqlScope.done();
    });

    it('reports usage for exception from subscription event stream', async ({ expect }) => {
      const graphqlScope = nock('http://localhost')
        .post('/usage', body => {
          expect(body.map).toMatchInlineSnapshot(`
          {
            c6cc5505189a301dcadc408034c21a2d: {
              fields: [
                Subscription.hi,
              ],
              operation: subscription{hi},
              operationName: anonymous,
            },
          }
        `);

          expect(body).toMatchObject({
            subscriptionOperations: [
              {
                operationMapKey: 'c6cc5505189a301dcadc408034c21a2d',
                metadata: {
                  client: {
                    name: 'brrr',
                    version: '1',
                  },
                },
              },
            ],
          });

          return true;
        })
        .reply(200);

      const yoga = createYoga({
        logging: false,
        schema: createSchema({
          typeDefs: /* GraphQL */ `
            type Query {
              hii: String
            }

            type Subscription {
              hi: String
            }
          `,
          resolvers: {
            Subscription: {
              hi: {
                /* eslint-disable-next-line require-yield */
                async *subscribe() {
                  throw new Error('Oof');
                },
              },
            },
          },
        }),
        plugins: [
          useHive({
            enabled: true,
            debug: false,
            token: 'brrrt',
            selfHosting: {
              applicationUrl: 'http://localhost/foo',
              graphqlEndpoint: 'http://localhost/graphql',
              usageEndpoint: 'http://localhost/usage',
            },
            usage: {
              endpoint: 'http://localhost/usage',
              clientInfo() {
                return {
                  name: 'brrr',
                  version: '1',
                };
              },
            },
            agent: {
              maxSize: 1,
              logger: createLogger('silent'),
            },
          }),
        ],
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          resolve();
        }, 1000);
        let requestCount = 0;

        graphqlScope.on('request', () => {
          requestCount = requestCount + 1;
          if (requestCount === 2) {
            clearTimeout(timeout);
            resolve();
          }
        });

        (async () => {
          const res = await yoga.fetch('http://localhost/graphql', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              query: `subscription { hi }`,
            }),
          });
          expect(res.status).toBe(200);
          expect(await res.text()).toMatchInlineSnapshot(`
            :

            event: next
            data: {"errors":[{"message":"Unexpected error.","locations":[{"line":1,"column":1}]}]}

            event: complete
          `);
        })().catch(reject);
      });
      graphqlScope.done();
    });
  });

  describe('@graphql-yoga/plugin-graphql-sse (distinct connection mode)', () => {
    it('reports usage for successful subscription operation', async ({ expect }) => {
      const graphqlScope = nock('http://localhost')
        .post('/usage', body => {
          expect(body.map).toMatchInlineSnapshot(`
          {
            c6cc5505189a301dcadc408034c21a2d: {
              fields: [
                Subscription.hi,
              ],
              operation: subscription{hi},
              operationName: anonymous,
            },
          }
        `);

          expect(body.subscriptionOperations[0].metadata.client).toEqual({
            name: 'my-client',
            version: '1.0.0',
          });

          return true;
        })
        .reply(200);

      const yoga = createYoga({
        logging: false,
        schema: createSchema({
          typeDefs: /* GraphQL */ `
            type Query {
              hii: String
            }

            type Subscription {
              hi: String
            }
          `,
          resolvers: {
            Subscription: {
              hi: {
                /* eslint-disable-next-line require-yield */
                async *subscribe() {
                  return;
                },
              },
            },
          },
        }),
        plugins: [
          useGraphQLSSE(),
          useHive({
            enabled: true,
            debug: false,
            token: 'brrrt',
            selfHosting: {
              applicationUrl: 'http://localhost/foo',
              graphqlEndpoint: 'http://localhost/graphql',
              usageEndpoint: 'http://localhost/usage',
            },
            usage: {
              endpoint: 'http://localhost/usage',
              /** With SSE we get the request as headers. */
              clientInfo(context: { request: Request }) {
                const name = context.request.headers.get('x-graphql-client-name');
                const version = context.request.headers.get('x-graphql-client-version');

                if (name && version) {
                  return {
                    name,
                    version,
                  };
                }
                return null;
              },
            },
            agent: {
              maxSize: 1,
              logger: createLogger('silent'),
            },
          }),
        ],
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          resolve();
        }, 1000);
        let requestCount = 0;

        graphqlScope.on('request', () => {
          requestCount = requestCount + 1;
          if (requestCount === 2) {
            clearTimeout(timeout);
            resolve();
          }
        });

        (async () => {
          const url = new URL('http://localhost/graphql/stream');
          url.searchParams.set('query', 'subscription { hi }');
          const res = await yoga.fetch(url, {
            method: 'GET',
            headers: {
              'Content-Type': 'text/event-stream',
              accept: 'text/event-stream',
              'x-graphql-client-name': 'my-client',
              'x-graphql-client-version': '1.0.0',
            },
          });

          expect(res.status).toBe(200);
          expect(await res.text()).toMatchInlineSnapshot(`
            :

            event: complete
            data:
          `);
        })().catch(reject);
      });
      graphqlScope.done();
    });

    it.skip('reports usage for exception from subscription event stream', async ({ expect }) => {
      const graphqlScope = nock('http://localhost')
        .post('/usage', body => {
          expect(body.map).toMatchInlineSnapshot(`
          {
            c6cc5505189a301dcadc408034c21a2d: {
              fields: [
                Subscription.hi,
              ],
              operation: subscription{hi},
              operationName: anonymous,
            },
          }
        `);

          expect(body).toMatchObject({
            subscriptionOperations: [{}],
          });

          return true;
        })
        .reply(200);

      const yoga = createYoga({
        logging: false,
        schema: createSchema({
          typeDefs: /* GraphQL */ `
            type Query {
              hii: String
            }

            type Subscription {
              hi: String
            }
          `,
          resolvers: {
            Subscription: {
              hi: {
                /* eslint-disable-next-line require-yield */
                async *subscribe() {
                  throw new Error('Oof');
                },
              },
            },
          },
        }),
        plugins: [
          useGraphQLSSE(),
          useHive({
            enabled: true,
            debug: false,
            token: 'brrrt',
            selfHosting: {
              applicationUrl: 'http://localhost/foo',
              graphqlEndpoint: 'http://localhost/graphql',
              usageEndpoint: 'http://localhost/usage',
            },
            usage: {
              endpoint: 'http://localhost/usage',
              clientInfo() {
                return {
                  name: 'brrr',
                  version: '1',
                };
              },
            },
            agent: {
              maxSize: 1,
              logger: createLogger('silent'),
            },
          }),
        ],
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          resolve();
        }, 1000);
        let requestCount = 0;

        graphqlScope.on('request', () => {
          requestCount = requestCount + 1;
          if (requestCount === 2) {
            clearTimeout(timeout);
            resolve();
          }
        });

        (async () => {
          const url = new URL('http://localhost/graphql/stream');
          url.searchParams.set('query', 'subscription { hi }');
          const res = await yoga.fetch(url, {
            method: 'GET',
            headers: {
              'Content-Type': 'text/event-stream',
              accept: 'text/event-stream',
              'x-graphql-client-name': 'foo',
              'x-graphql-client-version': '1',
            },
          });
          expect(res.status).toBe(200);
          expect(await res.text()).toMatchInlineSnapshot(`
            :
  
            event: next
            data: {"errors":[{"message":"Unexpected error.","locations":[{"line":1,"column":1}],"extensions":{"unexpected":true}}]}
  
            event: complete
            data:
          `);
        })().catch(reject);
      });

      graphqlScope.done();
    });
  });

  describe('graphql-ws', () => {
    it('reports usage for successful subscription operation', async ({ expect }) => {
      const graphqlScope = nock('http://localhost')
        .post('/usage', body => {
          expect(body.map).toMatchInlineSnapshot(`
        {
          c6cc5505189a301dcadc408034c21a2d: {
            fields: [
              Subscription.hi,
            ],
            operation: subscription{hi},
            operationName: anonymous,
          },
        }
      `);
          expect(body.subscriptionOperations[0].metadata.client).toEqual({
            name: 'foo',
            version: '1',
          });

          return true;
        })
        .reply(200);

      const yoga = createYoga({
        logging: false,
        schema: createSchema({
          typeDefs: /* GraphQL */ `
            type Query {
              hii: String
            }

            type Subscription {
              hi: String
            }
          `,
          resolvers: {
            Subscription: {
              hi: {
                /* eslint-disable-next-line require-yield */
                async *subscribe() {
                  return;
                },
              },
            },
          },
        }),
        plugins: [
          useHive({
            enabled: true,
            debug: false,
            token: 'brrrt',
            selfHosting: {
              applicationUrl: 'http://localhost/foo',
              graphqlEndpoint: 'http://localhost/graphql',
              usageEndpoint: 'http://localhost/usage',
            },
            usage: {
              endpoint: 'http://localhost/usage',
              clientInfo(ctx: {
                connectionParams?: {
                  client?: {
                    name?: string;
                    version?: string;
                  };
                };
              }) {
                const name = ctx.connectionParams?.client?.name;
                const version = ctx.connectionParams?.client?.version;
                if (name && version) {
                  return {
                    name,
                    version,
                  };
                }

                return null;
              },
            },
            agent: {
              maxSize: 1,
              logger: createLogger('silent'),
            },
          }),
        ],
      });
      const httpServer = createServer(yoga);
      const wsServer = new WebSocketServer({
        server: httpServer,
        path: yoga.graphqlEndpoint,
      });
      useWSServer(
        {
          execute: (args: any) => args.rootValue.execute(args),
          subscribe: (args: any) => args.rootValue.subscribe(args),
          onSubscribe: async (ctx, msg) => {
            const { schema, execute, subscribe, contextFactory, parse, validate } =
              yoga.getEnveloped({
                ...ctx,
                req: ctx.extra.request,
                socket: ctx.extra.socket,
                params: msg.payload,
              });

            const args = {
              schema,
              operationName: msg.payload.operationName,
              document: parse(msg.payload.query),
              variableValues: msg.payload.variables,
              contextValue: await contextFactory(),
              rootValue: {
                execute,
                subscribe,
              },
            };

            const errors = validate(args.schema, args.document);
            if (errors.length) return errors;
            return args;
          },
        },
        wsServer,
      );

      await new Promise<void>(resolve => {
        httpServer.listen(() => {
          resolve();
        });
      });

      const port = (httpServer.address() as any).port as number;

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          resolve();
        }, 1000);
        let requestCount = 0;

        graphqlScope.on('request', () => {
          requestCount = requestCount + 1;
          if (requestCount === 2) {
            clearTimeout(timeout);
            resolve();
          }
        });

        (async () => {
          const client = createClient({
            url: `ws://localhost:${port}${yoga.graphqlEndpoint}`,
            webSocketImpl: WebSocket,
            connectionParams: {
              client: {
                name: 'foo',
                version: '1',
              },
            },
          });

          const query = client.iterate({
            query: 'subscription { hi }',
          });

          const { done } = await query.next();
          expect(done).toEqual(true);
        })().catch(reject);
      });
      await new Promise<void>(resolve => {
        httpServer.close(() => {
          resolve();
        });
      });
      graphqlScope.done();
    });
    it.skip('reports usage for exception from subscription event stream', async ({ expect }) => {
      const graphqlScope = nock('http://localhost')
        .post('/usage', body => {
          expect(body.map).toMatchInlineSnapshot(`
        {
          c6cc5505189a301dcadc408034c21a2d: {
            fields: [
              Subscription.hi,
            ],
            operation: subscription{hi},
            operationName: anonymous,
          },
        }
      `);

          expect(body).toMatchObject({
            subscriptionOperations: [{}],
          });

          return true;
        })
        .reply(200);

      const yoga = createYoga({
        logging: false,
        schema: createSchema({
          typeDefs: /* GraphQL */ `
            type Query {
              hii: String
            }

            type Subscription {
              hi: String
            }
          `,
          resolvers: {
            Subscription: {
              hi: {
                /* eslint-disable-next-line require-yield */
                async *subscribe() {
                  throw new Error('Oof');
                },
              },
            },
          },
        }),
        plugins: [
          useHive({
            enabled: true,
            debug: false,
            token: 'brrrt',
            selfHosting: {
              applicationUrl: 'http://localhost/foo',
              graphqlEndpoint: 'http://localhost/graphql',
              usageEndpoint: 'http://localhost/usage',
            },
            usage: {
              endpoint: 'http://localhost/usage',
              clientInfo() {
                return {
                  name: 'brrr',
                  version: '1',
                };
              },
            },
            agent: {
              maxSize: 1,
              logger: createLogger('silent'),
            },
          }),
        ],
      });
      const httpServer = createServer(yoga);
      const wsServer = new WebSocketServer({
        server: httpServer,
        path: yoga.graphqlEndpoint,
      });
      useWSServer(
        {
          execute: (args: any) => args.rootValue.execute(args),
          subscribe: (args: any) => args.rootValue.subscribe(args),
          onSubscribe: async (ctx, msg) => {
            const { schema, execute, subscribe, contextFactory, parse, validate } =
              yoga.getEnveloped({
                ...ctx,
                req: ctx.extra.request,
                socket: ctx.extra.socket,
                params: msg.payload,
              });

            const args = {
              schema,
              operationName: msg.payload.operationName,
              document: parse(msg.payload.query),
              variableValues: msg.payload.variables,
              contextValue: await contextFactory(),
              rootValue: {
                execute,
                subscribe,
              },
            };

            const errors = validate(args.schema, args.document);
            if (errors.length) return errors;
            return args;
          },
        },
        wsServer,
      );

      await new Promise<void>(resolve => {
        httpServer.listen(() => {
          resolve();
        });
      });

      const port = (httpServer.address() as any).port as number;
      const client = createClient({
        url: `ws://localhost:${port}${yoga.graphqlEndpoint}`,
        webSocketImpl: WebSocket,
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          resolve();
        }, 1000);
        let requestCount = 0;

        graphqlScope.on('request', () => {
          requestCount = requestCount + 1;
          if (requestCount === 2) {
            clearTimeout(timeout);
            resolve();
          }
        });

        (async () => {
          const query = client.iterate({
            query: 'subscription { hi }',
          });

          const { value } = await query.next();
          expect(value).toMatchInlineSnapshot(`
            {
              errors: [
                {
                  extensions: {
                    unexpected: true,
                  },
                  locations: [
                    {
                      column: 1,
                      line: 1,
                    },
                  ],
                  message: Unexpected error.,
                },
              ],
            }
          `);
        })().catch(reject);
      });
      await new Promise<void>(resolve => {
        httpServer.close(() => {
          resolve();
        });
      });
      graphqlScope.done();
    });
  });
});

describe('incremental delivery usage reporting', () => {
  it('reports usage for successful incremental deliver operation', async ({ expect }) => {
    const graphqlScope = nock('http://localhost')
      .post('/usage', body => {
        expect(body.map).toMatchInlineSnapshot(`
          {
            4c76cedb3f9db3810a8080b299e93f1a: {
              fields: [
                Query.greetings,
              ],
              operation: {greetings@stream},
              operationName: anonymous,
            },
          }
        `);

        expect(body.operations).toMatchObject([
          {
            metadata: {
              client: {
                name: 'foo',
                version: '4.2.0',
              },
            },
          },
        ]);

        return true;
      })
      .reply(200);

    const yoga = createYoga({
      schema: createSchema({
        typeDefs: /* GraphQL */ `
          type Query {
            greetings: [String!]!
          }
        `,
        resolvers: {
          Query: {
            async *greetings() {
              yield 'hi';
              await new Promise<void>(resolve => setTimeout(resolve, 1));
              yield 'heee';
              await new Promise<void>(resolve => setTimeout(resolve, 1));
              yield 'hooo';
            },
          },
        },
      }),
      plugins: [
        useDeferStream(),
        useHive({
          enabled: true,
          debug: false,
          token: 'brrrt',
          selfHosting: {
            applicationUrl: 'http://localhost/foo',
            graphqlEndpoint: 'http://localhost/graphql',
            usageEndpoint: 'http://localhost/usage',
          },
          usage: {
            endpoint: 'http://localhost/usage',
          },
          agent: {
            maxSize: 1,
            logger: createLogger('silent'),
          },
        }),
      ],
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        resolve();
      }, 1000);
      let requestCount = 0;

      graphqlScope.on('request', () => {
        requestCount = requestCount + 1;
        if (requestCount === 2) {
          clearTimeout(timeout);
          resolve();
        }
      });

      (async () => {
        const res = await yoga.fetch('http://localhost/graphql', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            accept: 'multipart/mixed',
            'x-graphql-client-name': 'foo',
            'x-graphql-client-version': '4.2.0',
          },
          body: JSON.stringify({
            query: `query { greetings @stream }`,
          }),
        });
        expect(res.status).toBe(200);
        expect(await res.text()).toMatchInlineSnapshot(`
          ---
          Content-Type: application/json; charset=utf-8
          Content-Length: 40

          {"data":{"greetings":[]},"hasNext":true}
          ---
          Content-Type: application/json; charset=utf-8
          Content-Length: 72

          {"incremental":[{"items":["hi"],"path":["greetings",0]}],"hasNext":true}
          ---
          Content-Type: application/json; charset=utf-8
          Content-Length: 74

          {"incremental":[{"items":["heee"],"path":["greetings",1]}],"hasNext":true}
          ---
          Content-Type: application/json; charset=utf-8
          Content-Length: 74

          {"incremental":[{"items":["hooo"],"path":["greetings",2]}],"hasNext":true}
          ---
          Content-Type: application/json; charset=utf-8
          Content-Length: 17

          {"hasNext":false}
          -----
        `);
      })().catch(reject);
    });

    graphqlScope.done();
  });
});
