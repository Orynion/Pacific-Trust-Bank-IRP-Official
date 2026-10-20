# PTB Discord Ledger Bot

PTB is a roleplay bank ledger for Emergency Hamburg RP. It records balances in a database and does not move real in-game money.

## Requirements

- Node.js 20 or newer
- A Discord application and bot added to your server
- Give the bot **Manage Channels**, **View Channels**, and **Send Messages** permissions so it can create and initialize private request tickets
- A Turso database and auth token
- A Roblox OAuth app with the `openid` and `profile` scopes

## Run locally

1. Copy `.env.example` to `.env` and fill in the Discord and Turso values.
2. Install dependencies with `npm install`.
3. Start the bot with `npm start`.
4. In your Discord server, run `/ping`; the bot replies `pong`.

At startup, PTB creates the `accounts`, `transactions`, `oauth_sessions`, `pending_links`, `processed_interactions`, `tickets`, and `recurring_charges` tables if needed and registers slash commands (`/help`, `/ping`, `/register`, `/verify`, `/balance`, `/transaction history`, `/deposit`, `/withdraw`, `/add-balance`, `/transfer`, `/bill`) for the configured guild. `/help` privately shows a branded command guide and includes administrator commands only for members with Administrator permission. `/balance` shows only the invoking user's balance, privately. `/transaction history` shows that user's transaction history privately, with timestamps and Previous/Next pagination. `/deposit amount` and `/withdraw amount` open private request channels visible to the opener, the bot, and server administrators. Administrators review requests in the channel; opening a request does not change or reserve ledger funds. The opener or an administrator can close the ticket with its Close ticket button. The health-check server responds at `/health` on `PORT` (defaults to `3000` for local use).

## Recurring bills and taxes

Bills and taxes have separate command groups. Users privately view each type with `/bill list` or `/tax list`, and settle currently due charges separately with `/bill settle` or `/tax settle`; administrators can optionally specify an account. Settlement is all-or-nothing for that type: if the account cannot cover the total, nothing is deducted and its schedules do not change. Successful settlement writes a ledger entry for each due charge and advances each due date by one interval. The bot checks charges at startup and every minute. It sends a private Discord reminder within 24 hours before a charge is due, plus a transaction notice after automatic deductions and settlements. Reminder and transaction DMs require the member's Discord settings to allow messages from the bot. Each deduction and ledger entry is atomic and guarded against duplicate processing. Charges never overdraw: a frozen account or an account without enough funds receives a denied transaction entry, and that occurrence advances without being retried. This is a roleplay ledger feature and does not move real money.

## Deposit and withdrawal ticket workflow

Every `/deposit` and `/withdraw` request gets a unique, persistent transaction ID (`PTB-D-<n>` for deposits, `PTB-W-<n>` for withdrawals) stored in the `tickets` table with the requester, amount, status, and the Discord channel that belongs to it. The ticket channel contains administrator buttons that drive the ticket through its states:

1. **Approve** (pending → approved): an administrator verifies the request. For a deposit, approval marks that the receipt of in-game funds was verified; for a withdrawal, approval additionally re-checks that the requester still has the funds. Approving never moves money.
2. **Reject** (pending → rejected): no balances change. A pending ticket whose channel is closed is also recorded as rejected automatically. Rejected tickets can never be processed.
3. **Credit & finalise** (deposits, approved → completed): the requester's balance is credited and the `transactions` ledger row is written inside one atomic database transaction.
4. **Mark paid & deduct balance** (withdrawals, approved → completed): the in-game payout is delivered first; pressing this button debits the requester's balance and writes the ledger row inside one atomic database transaction, guarded so insufficient funds can never be overdrawn. The balance is deducted only at this final step.

The status flip, the balance change, and the ledger entry always commit together, so a ticket can be credited or paid out at most once — even if several administrators click buttons at the same time, a confirmation replays, or the bot restarts between steps. Every decision records the acting administrator (`decision_by`/`completion_by`), UTC timestamps, the amount, the final outcome, and a link to its ledger entry. Only server administrators can press the decision buttons (enforced server-side when the button is clicked); decided actions are visible in the ticket channel as an audit trail. Tickets that were already processed answer with the outcome and name the administrator who finished them. Note: tickets opened before this change carry no `tickets` row and cannot be processed retroactively.

Security hardening for this workflow: one open request is allowed per user and kind — a unique partial index on open `tickets` rows (`idx_tickets_open_per_user`) closes the race where two rapid `/deposit` or `/withdraw` invocations would both open tickets; a startup migration auto-closes any legacy duplicate pending rows so the index can never fail to build. Decision buttons are bound to the ticket's own private channel server-side, so a replayed or moved button interaction from any other channel is refused instead of flipping the ticket's state. The close button only works inside the real ticket channel (verified by channel id and the ticket topic) and is limited to the ticket opener or a server administrator.

## Roblox account linking

PTB links Roblox accounts through Roblox OAuth. Register a Roblox OAuth app in the Creator Dashboard, enable the `openid` and `profile` scopes, and register this exact callback URL with the app:

`https://<your-render-service>.onrender.com/oauth/roblox/callback`

Set `ROBLOX_CLIENT_ID`, `ROBLOX_CLIENT_SECRET`, and `ROBLOX_REDIRECT_URI` in `.env`. For local testing, register `http://localhost:3000/oauth/roblox/callback` as the app's redirect URI and use that exact value in `.env`. Localhost works only when the browser completing authorization is on the same machine running the bot. For a community bot where members authorize from their own devices, deploy it behind a public HTTPS URL and register that URL's `/oauth/roblox/callback` path instead. Then run `/register` in Discord and authorize PTB on Roblox; the callback creates the linked account.

OAuth security details: each authorisation uses a fresh cryptographically random `state`, PKCE (S256 `code_challenge` plus a verifier stored only server-side for 10 minutes), and one-time state consumption (the session row is deleted atomically as it is read). The `/oauth/roblox/callback` endpoint only accepts requests whose host matches the registered `ROBLOX_REDIRECT_URI` host, so rogue domains or DNS-rebinding hosts pointed at the same service cannot reach the callback logic. The token exchange sends the registered `redirect_uri` along with the client secret as required by RFC 6749. The confirmation step applies the Roblox identity only after the pending link is confirmed by the owning Discord user, and a Roblox identity can never be linked to two Discord accounts (unique index on `roblox_id`).

Roblox OAuth is currently documented as a beta feature and may change.

## Render

Create a Node web service for this repository. Set the build command to `npm install`, the start command to `npm start`, and add the variables from `.env.example` in the Render environment settings. Set `ROBLOX_REDIRECT_URI` to the exact public service URL ending in `/oauth/roblox/callback`. Render supplies `PORT` automatically.

## Testing

`npm test` runs the automated test suites in `src/bank-logic.test.js` (financial logic: balances, transfers, admin permissions, duplicate-confirmation protection, restart persistence, ledger completeness, concurrency), `src/transaction-history.test.js`, and `src/ticket-ops.test.js` (deposit/withdrawal tickets: double approval, simultaneous approvals, retried credits and payouts after failures, rejected tickets, fast racing payouts that cannot overspend, restart persistence, non-admin refusals). It also runs `src/security-exploits.test.js`, an attack suite that attempts concrete exploits against the production handlers: ticket-button privilege escalation, cross-channel ticket decisions, history-button IDOR, ticket-close abuse, DM usage, duplicate-ticket races, non-admin cross-account settlement, replayed settlements, and OAuth callback host binding/token-exchange requirements. Concurrent-write tests tolerate fail-closed `SQLITE_BUSY` rejections and assert database invariants. Each test uses its own throwaway local SQLite database created in the OS temporary directory; the configured Turso database and real balances are never used during testing.

Balance-changing commands (`/transfer`, `/add-balance`) also record the Discord interaction ID in `processed_interactions` inside the same database transaction as the balance change, so a duplicate or replayed confirmation is rejected and cannot apply the same transaction twice.
