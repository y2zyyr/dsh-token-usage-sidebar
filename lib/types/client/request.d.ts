/** Timeout a probe without aborting its caller's controller. */
export declare function usageRequest(url: string, init: RequestInit, signal?: AbortSignal): Promise<{
    ok: boolean;
    body: unknown;
}>;
