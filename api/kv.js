// OPTIONAL — only needed when you want a real global leaderboard.
// This is a Vercel serverless function backed by Vercel KV (Upstash Redis).
//
// To enable:
//   1) In the Vercel dashboard: Storage -> create a KV database, link it to this project.
//   2) `npm i @vercel/kv`
//   3) Set an env var VITE_API_BASE to your deployment origin (e.g. https://spot-on.vercel.app)
//      so the client talks to this endpoint. Redeploy.
//
// Until you do all that, the app runs local-only and this file is dormant.

import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const key = req.query.key;
      if (!key) return res.status(400).json({ error: "missing key" });
      const value = await kv.get(key);
      return res.status(200).json({ key, value: value ?? null });
    }
    if (req.method === "POST") {
      const { key, value } = req.body || {};
      if (!key) return res.status(400).json({ error: "missing key" });
      // 35-day TTL: daily leaderboards don't need to live forever
      await kv.set(key, value, { ex: 60 * 60 * 24 * 35 });
      return res.status(200).json({ key, value });
    }
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: "kv error" });
  }
}
