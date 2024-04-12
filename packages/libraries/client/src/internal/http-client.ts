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
    throw error;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
