# Party play operations

## Seat resume credentials

A seat resume token is a bearer credential: anyone who obtains it can prove control of that seat from a compatible client. The web client stores it in origin-scoped `localStorage`, which persists across tabs and browser restarts in the same browser profile, so a later page load can resume. **An XSS running on the application's origin can read this token.** Treat prevention of script injection and third-party script control as part of the credential boundary; the token is not protected from same-origin JavaScript by `localStorage`.

The token authorizes a single active WebSocket control claim for the bound table seat. Successful authentication rotates it before returning the replacement. Tickets bind to the account, table, seat, and authenticated login session and expire after 30 seconds. The initial token handoff is one-time, limited to the exact authenticated login session that seated the account, and expires after 30 seconds. These controls limit replay and cross-session token pickup but do not make XSS harmless: a script can still steal a token and race the legitimate client for the single socket. Keep the client origin free of untrusted script and revoke affected login sessions/seats if token theft is suspected.

If the token is absent, expired, or unavailable on another device, normal recovery requires host approval. The solo-owner restart exception is disabled unless `SOLO_OWNER_RESUME_RECOVERY_ENABLED=true` is explicitly set; it applies only to the eligible solo owner and never to party-seat recovery. This variable is not enabled in tracked production/deployment configuration.


## Gateway deployment note

The current seat-auth attempt limits are in-memory and per server process (5/min per seat, 30/min per account, 120/min per IP). They are appropriate for the current single-replica deployment; they do not form a shared limit across replicas, and their per-process key history is not centrally evicted. Revisit with a shared limiter before scaling the gateway horizontally.
