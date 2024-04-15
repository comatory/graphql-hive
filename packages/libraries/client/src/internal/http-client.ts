import { fetch } from '@whatwg-node/fetch';

export function get(
  endpoint: string,
  config: {
    headers: Record<string, string>;
    timeout?: number;
  },
) {
  return makeFetchCall(endpoint, {
    method: 'GET',
    headers: config.headers,
    timeout: config.timeout,
  });
}

export async function post(
  endpoint: string,
  data: string | Buffer,
  config: {
    headers: Record<string, string>;
    timeout?: number;
  },
) {
  return makeFetchCall(endpoint, {
    body: data,
    method: 'POST',
    headers: config.headers,
    timeout: config.timeout,
  });
}

async function makeFetchCall(
  endpoint: string,
  config: {
    body?: string | Buffer;
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    timeout?: number;
  },
) {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined = undefined;
  const responsePromise = fetch(endpoint, {
    method: config.method,
    body: config.body,
    headers: config.headers,
    signal: controller.signal,
  });

  if (config.timeout) {
    timeoutId = setTimeout(() => controller.abort(), config.timeout);
  }

  try {
    return await responsePromise;
  } catch (error) {
    if (isAggregateError(error)) {
      throw new Error(error.errors.map(e => e.message).join(', '), {
        cause: error,
      });
    }
    throw error;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

interface AggregateError extends Error {
  errors: Error[];
}

function isAggregateError(error: unknown): error is AggregateError {
  return !!error && typeof error === 'object' && 'errors' in error && Array.isArray(error.errors);
}
