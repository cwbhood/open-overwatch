// Fetch a data file, falling back to the published site. Archived versions (/v/<tag>/) and partial checkouts don't
// carry the big data files, so they read them from the site root instead of duplicating ~40 MB per version.

export const SITE = 'https://destinjones.github.io/open-overwatch/';

/** kind: 'buffer' (ArrayBuffer) | 'json' | 'text'. */
export async function fetchAsset(path, kind = 'buffer', { fetchImpl = globalThis.fetch, site = SITE } = {}) {
  let lastError;
  for (const url of [path, site + path]) {
    try {
      const r = await fetchImpl(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return kind === 'json' ? await r.json() : kind === 'text' ? await r.text() : await r.arrayBuffer();
    } catch (e) { lastError = e; }
  }
  throw new Error(`could not load ${path} (${lastError && lastError.message})`);
}
