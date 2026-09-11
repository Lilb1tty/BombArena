# BombArena

BombArena is an authoritative real-time multiplayer arena-game service. It
includes Account sessions, Rooms, deterministic Games, restricted Game Results,
and a browser client with pixel-art Players and arena blocks.

## Play online

Try it now: [arena.lil-bitty.com](https://arena.lil-bitty.com/)

## Run locally

Prerequisites: Node.js 24+ and Docker Compose.

For commands that use Prisma directly, copy `.env.example` to `.env` and adjust
the connection values for your local dependencies.

```sh
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Liveness and readiness
endpoints are available at `/health/live` and `/health/ready`; `/health`
remains a compatibility status endpoint. Readiness verifies MySQL and Redis.
`/metrics` exposes current WebSocket connection and Tick-delay counters.

To start the complete local stack, including MySQL and Redis:

```sh
docker compose up --build
```

The application waits for both dependencies to become healthy, applies the
committed Prisma migrations with `prisma migrate deploy`, then listens on port 3000. Named Docker volumes retain MySQL data between restarts.

## Launch and play

1. Open [arena.lil-bitty.com](https://arena.lil-bitty.com/) to play online, or
   start the complete local stack with `docker compose up --build` (or run
   MySQL and Redis locally, apply `npm run db:migrate`, then use `npm run dev`).
2. Register two to four Accounts in separate browser profiles (or with an HTTP
   client). One Account creates a Room; the other Accounts join with its Room
   Code, then every Player readies.
3. The Room countdown starts one authoritative Game. Connect each Player to
   `ws://localhost:3000/realtime?roomCode=ROOM_CODE` with its session cookie to
   receive snapshots and submit Game Inputs; reconnect with the same Account
   within the one-minute reconnection window if needed.

The service is deliberately a single-instance authoritative runtime. Active
connections, active Games, countdowns, and tick timing live in that process;
horizontal replicas or an uncoordinated restart can split ownership and abort
in-progress Games. The operations adapter must record active Games as aborted
on graceful shutdown and reconcile leftovers at startup. Until shared Game
ownership and durable coordination are introduced, run exactly one app
instance and treat a hard process loss as a possible aborted Game.

WebSocket payloads are capped at 10 KiB, game inputs are capped at 20 per
connection per second (and one movement plus one bomb placement per Player per
Tick), and Ping/Pong removes dead connections. Transport Ping/Pong is liveness
only; it does not renew a Login Session.

Participant-only detail is available at `GET /game-results/:resultId`; public
evidence is limited to `GET /public/game-results`, which contains completed
Game counts, wins, kills, win rate, and non-identifying recent summaries.

## Verification

```sh
npm run format
npm run typecheck
npm test
npm run build
```

Request logs are emitted as JSON to standard output, including a request ID,
method, path, response status, and duration.
