# Record a server-generated seed for randomized pickups

Each Game records a server-generated seed and uses it for Bomb Pickup placement. This preserves server authority while making random behaviour reproducible in tests and post-game diagnosis; client-provided randomness is never used.
