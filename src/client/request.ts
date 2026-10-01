/** Timeout a probe without aborting its caller's controller. */
export async function usageRequest(url: string, init: RequestInit, signal?: AbortSignal): Promise<{ ok: boolean; body: unknown }> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, 15_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    // The deadline covers the body as well as response headers.
    return { ok: response.ok, body: response.ok ? await response.json() : undefined };
  }
  finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
}
