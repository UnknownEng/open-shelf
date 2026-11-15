'use strict';

/**
 * Tiny router. Each route carries metadata (auth level, summary, tag) that the
 * request pipeline enforces and the OpenAPI generator documents.
 */
class Router {
  constructor() { this.routes = []; }

  add(method, path, opts, handler) {
    if (typeof opts === 'function') { handler = opts; opts = {}; }
    const keys = [];
    const pattern = path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
    this.routes.push({ method, path, re: new RegExp(`^${pattern}/?$`), keys, handler, ...opts });
    return this;
  }

  get(p, o, h) { return this.add('GET', p, o, h); }
  post(p, o, h) { return this.add('POST', p, o, h); }
  patch(p, o, h) { return this.add('PATCH', p, o, h); }
  delete(p, o, h) { return this.add('DELETE', p, o, h); }

  match(method, pathname) {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params = {};
      route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

module.exports = { Router };
