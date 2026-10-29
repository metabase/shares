// Placeholder for the first deploy to the Metabase account (SHR-2).
// It shows that the custom domains and the bindings work. CI deploys this file until [env.metabase] main points at src/index.ts.
export default {
  async fetch(request, env) {
    const host = new URL(request.url).host;
    const bindings = { DB: !!env.DB, BLOBS: !!env.BLOBS };
    return Response.json({ hello: "shares", host, bindings });
  },
};
