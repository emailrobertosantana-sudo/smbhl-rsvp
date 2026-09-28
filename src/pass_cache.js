// Lookups memoized for ONE cron pass. A pass reads the same league row,
// capability flags and league data.json once per event and step --
// several times per league per pass, every pass -- and nothing in the
// pass writes them (the cron never edits a league, a flag or a
// data.json; the one exception, a missing league slug being backfilled,
// updates the cached row too -- leagues.js getOrCreateLeagueSlug).
//
// The cache lives on a per-pass copy of env (withPassCache), never on
// env itself: env is shared by every request the isolate serves, and a
// request must always read the database as it is now. Outside a pass
// (no cache on env) passCached just runs the load.
export function withPassCache(env) {
  const passEnv = Object.create(env);
  // Defined, not assigned: an assignment would go through env when env is
  // a Proxy (the test runtime's is) and land on the shared env itself.
  Object.defineProperty(passEnv, 'passCache', { value: new Map() });
  return passEnv;
}

// load() runs once per key per pass; a load that fails is not kept.
export function passCached(env, key, load) {
  const cache = env && env.passCache;
  if (!cache) return load();
  if (!cache.has(key)) {
    cache.set(key, Promise.resolve().then(load).catch(e => { cache.delete(key); throw e; }));
  }
  return cache.get(key);
}
