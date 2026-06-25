# SPOT ON!

A daily word-hunt against the clock, built as a browser game / installable PWA.

## What this is

A complete Vite + React project, ready to deploy to Vercel as static hosting.
It runs **local-first**: all data (stats, streak, Gold flag, your daily results)
lives in the browser via `localStorage`. No backend required to go live.

The global leaderboard is **optional** and off by default (see below).

## Deploy to Vercel (fastest path)

Option A — from the Vercel CLI:

```bash
npm i -g vercel        # once
vercel                 # from this folder; accept the defaults
vercel --prod          # promote to production
```

Option B — from GitHub:

1. Push this folder to a new GitHub repo.
2. In Vercel: "Add New Project" -> import the repo.
3. Framework preset: **Vite**. Build command `npm run build`, output `dist`.
4. Deploy.

That's it. The game is live, local-first, installable to a phone home screen.

## Run locally

```bash
npm install
npm run dev      # http://localhost:5173
```

## Turning on the GLOBAL leaderboard (later)

Local-first means each device sees only its own runs. To make the daily
leaderboard global (everyone sees everyone), wire up the included serverless
function:

1. In Vercel: **Storage -> Create -> KV** (Upstash Redis). Link it to the project.
2. `npm i @vercel/kv`
3. Add an env var **VITE_API_BASE** = your deployment origin
   (e.g. `https://your-app.vercel.app`).
4. Redeploy.

`api/kv.js` is already written. The client (`src/storage.js`) automatically
uses it for shared data when `VITE_API_BASE` is set, and falls back to local
storage if a request fails. No game code changes.

## Known limitations (read before charging money)

- **Entitlement is client-side.** `spoton:spoton-gold` lives in the browser —
  trivially editable, lost on reinstall, not synced across devices. Fine for a
  free launch and for playtesting the paywall feel. NOT safe to take payment
  against. Real purchases need server-side entitlement tied to a login.
- **No accounts.** Initials only; the leaderboard (local or global) is
  spoofable. Add sign-in before money or competitive stakes.
- **Daily answers ship in the client bundle.** Anyone reading the JS can see
  today's solutions. Fine for a casual free game; move board generation
  server-side before a ranked, paid leaderboard.

## Project map

```
index.html              app shell, PWA meta
src/main.jsx            entry; installs the storage adapter + service worker
src/storage.js         localStorage <-> optional backend adapter
src/SpotOn.jsx         the game
public/manifest.webmanifest, icon.svg, sw.js   PWA assets
api/kv.js              optional Vercel KV leaderboard endpoint (dormant by default)
vercel.json            SPA rewrite + framework hint
```
