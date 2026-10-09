// Edge Middleware — festivefrens.fun domain routing.
// vercel.json rewrites with `has: [{type:"host"}]` do not match source "/" on
// Vercel (verified 2026-10-09: identical host conditions work on "/t1" but never
// on "/"), so the root-path routing lives here instead. Reads the Host header
// directly and internally rewrites / to the right board. The rewrite targets an
// explicit file (/frens.html or /index.html) so the subrequest never re-matches
// this middleware (matcher is exactly "/") — a bare fetch(request) passthrough
// re-triggers the middleware and Vercel kills it as INFINITE_LOOP_DETECTED.
export const config = {
  matcher: '/',
};

export default async function middleware(request) {
  const host = (request.headers.get('host') || '').toLowerCase().split(':')[0];
  const url = new URL(request.url);
  if (url.pathname === '/') {
    url.pathname =
      host === 'festivefrens.fun' || host === 'www.festivefrens.fun'
        ? '/frens.html'
        : '/index.html';
    return fetch(url.toString(), request);
  }
  return fetch(request);
}
