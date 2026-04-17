import dns from 'node:dns/promises';

export type MxRecord = { exchange: string; priority: number };

export type MxResolveResult = {
  records: MxRecord[];
  null_mx: boolean;
  error: string | null;
};

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 10_000;

function ttlMs(): number {
  const raw = process.env['MX_DOMAIN_CACHE_TTL_MS'];
  if (raw === undefined || raw === '') return DEFAULT_TTL_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MS;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

const cache = new Map<string, { expires: number; value: MxResolveResult }>();
const inflight = new Map<string, Promise<MxResolveResult>>();

async function resolveMailHostsUncached(domain: string): Promise<MxResolveResult> {
  try {
    const mx = await dns.resolveMx(domain);
    const nullMx = mx.some((r) => r.exchange === '.');
    if (nullMx) {
      return { records: mx, null_mx: true, error: null };
    }
    const sorted = [...mx].sort((a, b) => a.priority - b.priority);
    return { records: sorted, null_mx: false, error: null };
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENODATA' || err.code === 'ENOTFOUND' || err.code === 'NXDOMAIN') {
      try {
        await dns.resolve4(domain);
        return {
          records: [{ exchange: domain, priority: 0 }],
          null_mx: false,
          error: null,
        };
      } catch {
        try {
          await dns.resolve6(domain);
          return {
            records: [{ exchange: domain, priority: 0 }],
            null_mx: false,
            error: null,
          };
        } catch {
          return { records: [], null_mx: false, error: 'no MX or address records for domain' };
        }
      }
    }
    return { records: [], null_mx: false, error: err.message || 'DNS lookup failed' };
  }
}

function evictIfNeeded(): void {
  while (cache.size >= MAX_ENTRIES) {
    const first = cache.keys().next().value;
    if (first === undefined) break;
    cache.delete(first);
  }
}

function setCache(key: string, value: MxResolveResult): void {
  evictIfNeeded();
  const ttl = ttlMs();
  if (ttl === 0) return;
  cache.set(key, { expires: Date.now() + ttl, value: clone(value) });
}

/**
 * MX + A/AAAA fallback for the domain, with in-memory TTL cache (per process).
 * Set `MX_DOMAIN_CACHE_TTL_MS` (milliseconds); `0` disables caching.
 */
export async function resolveMailHostsCached(domain: string): Promise<{
  result: MxResolveResult;
  from_cache: boolean;
}> {
  const key = domain.toLowerCase();
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) {
    return { result: clone(hit.value), from_cache: true };
  }

  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      const value = await resolveMailHostsUncached(domain);
      setCache(key, value);
      return value;
    })().finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, p);
  }

  const result = await p;
  return { result: clone(result), from_cache: false };
}
