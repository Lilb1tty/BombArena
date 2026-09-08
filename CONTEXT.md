# Pixel Arena

Pixel Arena is a real-time multiplayer arena-game service. Its game rules are resolved by the server and surfaced to connected players.

## Language

**Player**:
A human participant represented inside one game room, linked to an Account for identity and reconnection.
_Avoid_: user, client, account

**Account**:
The registered identity that authenticates a person to Pixel Arena through a globally unique, case-insensitive public username.
_Avoid_: player, user session

**Password Credential**:
An Account's password representation, stored only as an Argon2id hash with a unique salt.
_Avoid_: password, password digest

**Room**:
A bounded 2–4 player game session with a single authoritative server owner that hosts exactly one Game.
_Avoid_: lobby, match

**Room Code**:
A short, human-shareable identifier used to find and request entry to a Room.
_Avoid_: invite link, lobby ID

**Authoritative Room**:
The sole server-side owner of a Room's current game state and rule outcomes.
_Avoid_: shared state, client authority

**Game**:
The single competition conducted in a Room, ending as finished or aborted.
_Avoid_: match, round

**Game Result**:
The persisted final or aborted outcome of a Game, visible in detail only to participating Accounts.
_Avoid_: match history, score record

**Breakable Block**:
A map cell that blocks movement and is removed when reached by an explosion.
_Avoid_: wall, obstacle

**Bomb Pickup**:
A temporary map item that restores one available bomb to the Player who collects it.
_Avoid_: power-up, bomb drop

**Available Bomb**:
A bomb a living Player may place; a Player may hold at most two, and it is consumed on placement.
_Avoid_: ammo, bomb capacity

**Active Bomb**:
A placed, non-blocking bomb with an explosion countdown; a Player may own at most two at once.
_Avoid_: deployed ammo

**Game Seed**:
The server-generated value recorded for a Game to reproduce its randomized Bomb Pickup placement.
_Avoid_: random state, client seed

**Disconnected Player**:
A Player who remains in a running Game but cannot submit Game Inputs during the Reconnection Window.
_Avoid_: paused player, inactive client

**Game Input**:
A Player's request to perform an allowed action; it is not a statement that the action occurred.
_Avoid_: game event, state update

**Login Session**:
An independently revocable authenticated session for an Account, renewable for 20 minutes since its last valid activity.
_Avoid_: login token, credential

**Reconnection Window**:
The one-minute period after an in-game connection is lost during which its Player may reclaim the same Room presence.
_Avoid_: grace period, resume token
