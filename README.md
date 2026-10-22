# PUTIN vs ZELENSKY — TikTok LIVE Arena

A mobile-first arcade-style fan-made game with a separate PC dashboard.

## Deploy
Render should install dependencies from package.json and run `npm start` with Node.js 20 or newer. The app listens on the Render-provided PORT and 0.0.0.0.

## Use
- Main mobile game: /
- PC control room: /pc.html
- Health check: /health
- In the PC control room, enter the LIVE creator username without @ and choose Connect LIVE.
- Viewers type PUTIN / RUSSIA / TEAM RED or ZELENSKY / UKRAINE / TEAM BLUE to select a side.
- Likes add points to the team that is behind; gifts add points to the sender's selected team. Demo buttons let you test the UI.

## Important limitations
This uses the unofficial, reverse-engineered tiktok-live-connector package. TikTok changes may break it, and a connection attempt can fail even if the app deploys successfully. The game has not been verified against a live account in this deployment. Do not enter TikTok passwords or cookies. The PC dashboard currently has no login protection, so use it only while you control access to the URL.
