# PTB Discord Ledger Bot

PTB is a roleplay bank ledger for Emergency Hamburg RP. It records balances in a database and does not move real in-game money.

## Requirements

- Node.js 20 or newer
- A Discord application and bot added to your server
- Give the bot **Manage Channels**, **View Channels**, and **Send Messages** permissions so it can create and initialize private request tickets
- A Turso database and auth token
- A Bloxlink guild API key for the configured Discord server

## Run locally

1. Copy `.env.example` to `.env` and fill in the Discord and Turso values.
2. Install dependencies with `npm install`.
3. Start the bot with `npm start`.
4. In your Discord server, run `/ping`; the bot replies `pong`.

At startup, PTB creates the `accounts`, `transactions`, `processed_interactions`, `tickets`, and `recurring_charges` tables if needed and registers slash commands (`/help`, `/ping`, `/register`, `/unregister`, `/balance`, `/transaction history`, `/deposit`, `/withdraw`, `/add-balance`, `/transfer`, `/bill`, `/tax`) for the configured guild. Registration settings are validated at startup; missing Bloxlink settings disable registration while the bot remains available for existing banking services. `/help` privately shows a branded command guide and includes administrator commands only for members with Administrator permission. `/register` checks Bloxlink and links the verified Roblox identity; after Bloxlink assigns its verified role, PTB also registers automatically. `/unregister` disconnects the invoking user's Roblox identity while preserving their PTB balance and transaction history; they can run `/register` later to link again. `/balance` shows only the invoking user's balance, privately. `/transaction history` shows that user's transaction history privately, with timestamps and Previous/Next pagination. `/deposit amount` and `/withdraw amount` open private request channels visible to the opener, the bot, and server administrators. Administrators review requests in the channel; opening a request does not change or reserve ledger funds. The opener or an administrator can close the ticket with its Close ticket button. The health-check server responds at `/health` on `PORT` (defaults to `3000` for local use).

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

## Roblox account registration through Bloxlink

Players run `/register` to have PTB query Bloxlink immediately. If Bloxlink already has a Roblox link for their Discord account, PTB confirms the reverse mapping, creates the PTB account, and assigns the Registered role even if Bloxlink's role event has not arrived. If there is no Bloxlink link yet, the command displays a **Verify with Bloxlink** button linking to Bloxlink's official verification page; after the user completes Roblox proof there, PTB registers automatically when Bloxlink assigns its verification role. Configure Bloxlink to assign its verification role and set the member nickname template to `{roblox-name}` for a readable server nickname. PTB resolves Discord-to-Roblox and then confirms the reverse Roblox-to-Discord mapping through Bloxlink's guild API using `BLOXLINK_API_KEY`; Roblox's public user profile API supplies the canonical username for the trusted numeric ID. PTB never treats a Discord nickname as evidence of Roblox ownership. If either Bloxlink lookup is missing, unavailable, rate-limited, or inconsistent, registration fails closed and roles remain unchanged.

Bloxlink documents this guild-scoped Discord-to-Roblox lookup through its [Node SDK](https://github.com/DaStormer/bloxlink-api-sdk). Create a guild key from the [Bloxlink user developer dashboard](https://blox.link/dashboard/user/developer), and store it as `BLOXLINK_API_KEY` in the deployment host only. Do not put the key in source control, `.env.example`, or logs. This integration requires that key to have access to the configured guild.

Configure these values in `.env` or the deployment environment:

- `GUILD_ID`: PTB's Discord server ID.
- `BLOXLINK_VERIFIED_ROLE_ID`: the exact Bloxlink verification role ID. Use the role Bloxlink assigns after successful verification.
- `REGISTERED_ROLE_ID`: the ID of the PTB role named `Registered`, granted after the identity is registered. Create this role in **Server Settings → Roles** before starting PTB.
- `BLOXLINK_API_KEY`: the guild API key created in Bloxlink's developer dashboard.

To copy role IDs, enable Developer Mode in Discord, right-click each role under **Server Settings → Roles**, and choose **Copy Role ID**. Enable the **Server Members Intent** for PTB in the Discord Developer Portal and include it in the deployed bot configuration. Place PTB's bot role above both configured roles in the role list and give it **Manage Roles**. Bloxlink also needs permission to assign its own verification role and manage nicknames. In the Bloxlink server dashboard, set the verification role to the ID represented by `BLOXLINK_VERIFIED_ROLE_ID`; set the nickname template to `{roblox-name}` if you want the nickname to show the Roblox username. PTB validates IDs at startup and checks that both roles exist, are below its highest role, and are assignable. Registration stays disabled if those checks fail; banking remains available.

Registration is idempotent. `/unregister` clears only the Roblox ID and username; it preserves the PTB account, balance, and ledger history. A later `/register` can link a verified Roblox identity to that existing account. Each Discord ID and Roblox ID can have only one active link, and a Discord account linked to another Roblox identity is never overwritten. Database writes happen before role changes. PTB grants `REGISTERED_ROLE_ID` and only then removes the Bloxlink verification role; on lookup, database, or role-assignment errors, it retains the verification role for administrator follow-up. The Bloxlink mapping is the trusted verification source; the nickname is display-only.
## Render

Create a Node web service for this repository. Set the build command to `npm install`, the start command to `npm start`, and add the variables from `.env.example` in the Render environment settings. In the Render Dashboard, open the PTB service, select **Environment**, and add `GUILD_ID=1558112811513552977`, `BLOXLINK_API_KEY`, `BLOXLINK_VERIFIED_ROLE_ID`, and `REGISTERED_ROLE_ID` under **Environment Variables**. Render supplies `PORT` automatically.

## Testing

`npm test` runs the automated test suites in `src/bank-logic.test.js` (financial logic: balances, transfers, admin permissions, duplicate-confirmation protection, restart persistence, ledger completeness, concurrency), `src/transaction-history.test.js`, and `src/ticket-ops.test.js` (deposit/withdrawal tickets: double approval, simultaneous approvals, retried credits and payouts after failures, rejected tickets, fast racing payouts that cannot overspend, restart persistence, non-admin refusals). It also runs `src/security-exploits.test.js` plus `src/bloxlink-registration.test.js` (trusted Bloxlink lookup, registration conflicts, retry safety, concurrency, Discord failures, and ledger preservation), an attack suite that attempts concrete exploits against the production handlers: ticket-button privilege escalation, cross-channel ticket decisions, history-button IDOR, ticket-close abuse, DM usage, duplicate-ticket races, non-admin cross-account settlement, and replayed settlements. Concurrent-write tests tolerate fail-closed `SQLITE_BUSY` rejections and assert database invariants. Each test uses its own throwaway local SQLite database created in the OS temporary directory; the configured Turso database and real balances are never used during testing.

Balance-changing commands (`/transfer`, `/add-balance`) also record the Discord interaction ID in `processed_interactions` inside the same database transaction as the balance change, so a duplicate or replayed confirmation is rejected and cannot apply the same transaction twice.
