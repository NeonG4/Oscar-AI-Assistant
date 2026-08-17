/**
 * api/health.js
 * ----------------------------------------------------------------------------
 * Open this in a browser right after deploying. It tells you whether the
 * environment variables actually landed, without ever echoing their values.
 */

export default function handler(req, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(
    JSON.stringify({
      ok: true,
      service: 'oscar',
      time: new Date().toISOString(),
      config: {
        openaiKey: Boolean(process.env.OPENAI_API_KEY),
        sharedSecret: Boolean(process.env.OSCAR_SHARED_SECRET),
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini (default)',
        maxWords: Number(process.env.OSCAR_MAX_WORDS) || 60,
      },
    })
  );
}
