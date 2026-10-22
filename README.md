# TikTok LIVE Monitor

A lightweight dashboard for monitoring TikTok LIVE chat, likes, viewer count, gifts, supporters, and connection events while streaming a game such as Minecraft from a PS4.

## Deploy
Render installs dependencies from `package.json` and runs `npm start` with Node.js 20 or newer. The server listens on the Render-provided `PORT`.

## Use
- Open the monitor at `/monitor` or `/dashboard.html`.
- Enter the TikTok creator username without `@` and choose **Connect to LIVE**.
- Open the creator's TikTok LIVE from the dashboard if needed.
- The monitor displays events delivered by the TikTok connector in real time.

## Important limitations
This uses the unofficial, reverse-engineered `tiktok-live-connector` package. TikTok changes or LIVE access restrictions can interrupt the connection, and not every metric is always available. Never enter TikTok passwords or cookies. The dashboard currently has no login protection, so only share its URL with people you trust.
