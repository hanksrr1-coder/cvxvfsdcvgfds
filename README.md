# NEON VAULT — browser multiplayer casino

A playable starter project with a Three.js 3D casino floor, accounts, persistent virtual-chip balances, multiplayer player movement, blackjack, roulette, slots, and proximity voice chat.

## Requirements
- Node.js 20 or newer
- A modern desktop browser with WebGL
- Microphone permission for voice chat
- HTTPS for microphone access when deployed (localhost is allowed during development)

## Run locally
1. Extract this ZIP.
2. Open a terminal in the `neon_vault_casino` folder.
3. Run `npm install`
4. Run `npm start`
5. Open http://localhost:3000 in your browser.
6. Create an account. Every new account receives 1,000 virtual chips.
7. Click the 3D floor to lock the mouse; use WASD to move, mouse to look, and E near a table or slot machine to play.

## Multiplayer / voice
The server uses Socket.IO for live player positions and WebRTC signaling. Click **Enable voice** and allow microphone access. Voice peers are connected when players are within approximately 12 in-game metres. For public deployment, configure a TURN relay in `public/game.js` for reliable voice connections across restrictive NATs/firewalls. The included Google STUN server alone is not sufficient for every network.

## Deployment
Deploy the Node app to a host that supports persistent storage and WebSockets. Use HTTPS, set a strong `SESSION_SECRET`, and attach persistent storage for `casino.sqlite` and `sessions.sqlite`. For multiple server instances, replace the in-process player/game state with a shared store and Socket.IO adapter.

## Current MVP scope / important notes
- Virtual chips only. They have no cash value and cannot be deposited, purchased, or withdrawn.
- Accounts and balances persist in SQLite. Game rounds and player positions are server-hosted; the current blackjack table is a shared single table.
- Blackjack supports hit, stand, double, dealer stands on soft/hard 17, and basic win/push/loss settlement. Split and insurance are not implemented in this starter.
- Roulette supports single-number, red/black, and even/odd bets on a European 0–36 result.
- Slots support three reels, pairs, triples, and a higher triple-seven payout.
- This is a functional starter/MVP, not a production-audited casino. Add rate limiting, CSRF protection, robust input validation, TURN infrastructure, moderation/reporting, reconnect handling, and security review before public release.

## Public deployment (Render)
This project includes `render.yaml` for a Render Web Service with WebSockets and a persistent disk for SQLite accounts, chip balances, and sessions.

1. Create a GitHub account if you do not already have one.
2. Create a **new private repository** on GitHub named `neon-vault-casino`.
3. Extract this ZIP and upload its contents (the files inside the folder, including `render.yaml`) to that repository.
4. Sign in at https://render.com and choose **New → Blueprint**.
5. Connect GitHub, select `neon-vault-casino`, and deploy the blueprint. Render will create the service, generate `SESSION_SECRET`, and attach a persistent disk.
6. When deployment finishes, open the `onrender.com` URL shown on the Render service page. Share that URL with players.

The Render Starter service and persistent disk are paid resources; check Render's current pricing before deploying. Keep `SESSION_SECRET` private. Do not use real-money deposits or wagering with this starter. The included balances are virtual chips only. Voice chat requires HTTPS (provided by Render) and may need a TURN server for reliable connections.
