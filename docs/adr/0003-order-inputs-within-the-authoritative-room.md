# Order same-tick inputs at the authoritative room

An Authoritative Room processes its received Game Inputs in arrival order within each Tick and accepts at most one movement and one bomb-placement request per Player per Tick. This gives simultaneous network traffic a deterministic, testable outcome without pretending distributed clients can share a global clock.
