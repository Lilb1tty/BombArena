# Use server-side sliding sessions for account authentication

BombArena uses Redis-backed server-side sessions carried by secure HTTP-only cookies, rather than client-held JWTs. This makes 20-minute activity-based expiry, session invalidation, and HTTP/WebSocket identity checks explicit parts of the service while avoiding a refresh-token lifecycle that does not serve the MVP.
