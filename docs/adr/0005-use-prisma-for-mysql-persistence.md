# Use Prisma for MySQL persistence and migrations

BombArena uses Prisma for its MySQL schema, versioned migrations, typed persistence, and transactional completed-game writes. This makes the persistence model readily inspectable in a TypeScript portfolio project while reserving parameterized SQL for exceptional aggregate queries.
