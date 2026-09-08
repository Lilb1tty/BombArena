# Keep active room state on one authoritative server instance

Each active Room is owned and simulated by one Node.js process; its live state is not replicated into MySQL or Redis on every tick. This keeps rule resolution and ordering clear for the MVP, while Redis is reserved for sessions and room discovery and MySQL for completed-game history.
