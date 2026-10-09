// Edge Middleware — festivefrens.fun domain routing.
// vercel.json rewrites with `has: [{type:"host"}]` do not match source "/" on
// Vercel (verified 2026-10-09: identical host conditions work on "/t1" but never
// on "/"), so the root-path routing lives here instead. Reads the Host header
// directly and internally rewrites / -> /frens.html for the custom domain only.
// muse-pull.vercel.app and every other path pass through untouched.
export const config = {
  matcher: '/',
};

export default async function middleware(request) {
  const host = (request.headers.get('host') || '').toLowerCase().split(':')[0];
  if (host === 'festivefrens.fun' || host === 'www.festivefrens.fun') {
    const url = new URL(request.url);
    url.pathname = '/frens.html';
    return fetch(url.toString(), request);
  }
  return fetch(request);
}
