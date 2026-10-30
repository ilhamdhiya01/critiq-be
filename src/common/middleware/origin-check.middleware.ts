import type { NextFunction, Request, Response } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Server-to-server: GitHub/GitLab deliveries carry no browser Origin and
// authenticate by signature/secret instead.
const EXEMPT_PATH_PREFIXES = ['/api/v1/webhooks/'];

// CSRF guard (CLAUDE.md "Keamanan"). The session rides a cookie, so a
// state-changing request must come from the FE's own origin. Browsers send
// `Origin` on every cross-origin request and on same-origin POST/PUT/PATCH/
// DELETE; when it is absent, `Sec-Fetch-Site` still tells a cross-site
// request apart. With neither, it is not a browser (curl, a script) and
// carries no ambient cookie worth forging — let it through to the guards.
// Defense in depth next to SameSite=Lax: Lax still lets a same-site
// sibling (another subdomain) POST with the cookie.
export function originCheck(feUrl: string) {
  const allowedOrigin = new URL(feUrl).origin;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (
      SAFE_METHODS.has(req.method) ||
      EXEMPT_PATH_PREFIXES.some((prefix) => req.path.startsWith(prefix))
    ) {
      next();
      return;
    }

    const origin = req.headers.origin;
    const fetchSite = req.headers['sec-fetch-site'];
    const forbidden =
      origin !== undefined
        ? origin !== allowedOrigin
        : fetchSite === 'cross-site';
    if (forbidden) {
      // Same body shape as HttpExceptionFilter — this runs before Nest.
      res.status(403).json({
        errors: [{ field: '', message: 'origin_not_allowed' }],
      });
      return;
    }
    next();
  };
}
