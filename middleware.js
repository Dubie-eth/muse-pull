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
  if (url.pathname !== '/') {
    return fetch(request);
  }
  url.pathname =
    host === 'festivefrens.fun' || host === 'www.festivefrens.fun'
      ? '/frens.html'
      : '/index.html';
  // Fetch the file WITHOUT accept-encoding: the edge runtime can decode a
  // compressed subrequest body while leaving `content-encoding` intact, which
  // makes real browsers (they send Accept-Encoding: br) fail decoding and
  // render a blank page. Uncompressed + stripped headers serves clean HTML.
  const headers = new Headers(request.headers);
  headers.delete('accept-encoding');
  const res = await fetch(url.toString(), { headers });
  const outHeaders = new Headers(res.headers);
  outHeaders.delete('content-encoding');
  outHeaders.delete('content-length');
  return new Response(res.body, { status: res.status, headers: outHeaders });
}
