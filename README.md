# app-invite-kit

Invite codes for any React Native / Expo app (iOS, Android, web), or any TypeScript app.
One person (the **host**) makes a short code; another person (the **guest**) types it to join them. What "joined" means
(a shared list, a shared budget, a team, a game) is up to your app: the kit only makes, checks and uses codes, and keeps
track of who is connected to whom.

- **Readable codes**: 6 capitals and digits with no look-alikes (no 0 O 1 I L), shown as `K7Q-2MX`. Typing is forgiving (any case, spaces, dashes).
- **Single use**: each code lets in one guest, once.
- **Expiry from your config**: `expiryMinutes` is required, so it is never hidden in the kit.
- **One connection per person**: someone already connected can't join another connection until they leave.
- **One-to-one or groups**: `maxMembers` is 2 by default (host + one guest); raise it for groups (one code per guest).
- **Your own rules on top**: `canCreate` / `canJoin` hooks (paid plan only, blocked users …) and an `onConnected` callback.
- **Any database**: storage sits behind a small `InviteStore` interface. A Cloud Firestore store and security rules come with the kit; a memory store is included for tests.
- **No words or screens**: results carry a reason (`'expired'`, `'used'` …) and your app says it in its own words and language.

**Current version: 2.0.0** (tag `v2.0.0`)

One of the shared kits, alongside [app-core-kit](https://github.com/yuvarajsalla20/app-core-kit), [app-auth-kit](https://github.com/yuvarajsalla20/app-auth-kit), [app-account-kit](https://github.com/yuvarajsalla20/app-account-kit) and [app-settings-kit](https://github.com/yuvarajsalla20/app-settings-kit). A "Connect as Family" page in Settings is typically an app-settings-kit `extraPages` entry whose content uses this kit.

## Install

```jsonc
// package.json
"dependencies": {
  "app-invite-kit": "git+https://github.com/yuvarajsalla20/app-invite-kit.git#<full SHA of v2.0.0>"
},
"kitVersions": {
  "app-invite-kit": "v2.0.0"
}
```

Pin the full commit SHA of a release tag, and write the tag in `kitVersions`. Find a SHA with `git ls-remote https://github.com/yuvarajsalla20/app-invite-kit refs/tags/v2.0.0`.

**Peer dependencies:** `firebase` ≥ 10, optional, needed only for `app-invite-kit/firestore`. The core has no dependencies; pass a secure random source (`expo-crypto`, or `crypto.getRandomValues` on the web and Node 19+).

## Entry points

| Import | What it holds |
|---|---|
| `app-invite-kit` | `createInviteKit`, `memoryInviteStore`, the code helpers (`makeCode`, `normalizeCode`, `formatCode`, `DEFAULT_ALPHABET`, `DEFAULT_LENGTH`), `DEFAULT_MAX_MEMBERS`, `KIT_NAME`, `KIT_VERSION` and the types. No database code |
| `app-invite-kit/firestore` | `firestoreInviteStore(db, names?)`, `DEFAULT_FIRESTORE_NAMES`, `CLOCK_MARGIN_MS` |

## Quick start

```ts
// invites.ts — one per app
import * as Crypto from 'expo-crypto';            // or: (b) => crypto.getRandomValues(b) on the web / Node 19+
import { createInviteKit } from 'app-invite-kit';
import { firestoreInviteStore } from 'app-invite-kit/firestore';
import { db } from './firebase';

export const invites = createInviteKit({
  store: firestoreInviteStore(db),
  config: { expiryMinutes: 30 },
  random: (bytes) => Crypto.getRandomValues(bytes),
});
```

```ts
// Host: make a code and show it
const made = await invites.create(myUserId);
if (made.ok) show(formatCode(made.invite.code), `Expires in ${invites.minutesLeft(made.invite)} min`);

// Guest: check it (to show who invited them), then accept
const seen = await invites.check(typedCode, myUserId);
const joined = await invites.accept(typedCode, myUserId);
if (joined.ok) openShared(joined.connection.id);
else say(MESSAGES[joined.problem]);              // your own words for each problem

// Either: leave
await invites.leave(myUserId);
```

## Options

`createInviteKit({ store, config, random, hooks?, now? })`

| Option | Required | What it is |
|---|---|---|
| `store` | yes | Where invites and connections live: `firestoreInviteStore(db)`, `memoryInviteStore()`, or your own `InviteStore` |
| `random` | yes | Fills a byte array with secure random values (`crypto.getRandomValues`, `expo-crypto`) |
| `config.expiryMinutes` | yes | How long a code works, in minutes |
| `config.maxMembers` | no | People in one connection, host included. Default `2` (one-to-one) |
| `config.length` | no | Letters in a code. Default `6` (at least 4) |
| `config.alphabet` | no | Letters a code is made from: capitals and digits, each once. Default `ABCDEFGHJKMNPQRSTUVWXYZ23456789` |
| `hooks.canCreate(hostId)` | no | Your check before a code is made. Return false to refuse with `'not-allowed'` |
| `hooks.canJoin(guestId, invite)` | no | Your check before a guest joins. Return false to refuse with `'not-allowed'` |
| `hooks.onConnected(connection)` | no | Called on the guest's device after joining |
| `now` | no | The time in milliseconds. Default `Date.now` (tests pass their own) |

## What you get back

| Method | Returns |
|---|---|
| `create(hostId)` | `{ ok: true, invite }` or `{ ok: false, problem }`. The host's older unused codes stop working |
| `check(code, guestId)` | `{ ok: true, invite }` or `{ ok: false, problem }`, without using the code |
| `accept(code, guestId)` | `{ ok: true, connection }` or `{ ok: false, problem }` |
| `cancel(hostId)` | Stops the host's unused codes |
| `connectionOf(userId)` | The person's own connection `{ id, hostId, guestId, memberIds, createdAt }`, or `null`. `guestId` is the first guest still in it |
| `leave(userId)` | One-to-one, or the host leaving: the connection ends for everyone (and the host's unused codes stop). A guest in a group: just that guest goes |
| `disconnect(connectionId)` | Ends the connection for everyone |
| `minutesLeft(invite)` | Minutes left on a code, rounded up |
| `formatCode(code, group?, separator?)` (a function, imported on its own) | `K7Q2MX` → `K7Q-2MX` |

### Problems

| `problem` | When |
|---|---|
| `not-found` | No such code: a typo, cancelled, replaced by a newer code, or made for a group that has since ended |
| `expired` | Past `expiryMinutes` |
| `used` | Someone already used it |
| `own-code` | The host typed their own code |
| `already-connected` | This person is already in a connection (a guest in a group can't invite) |
| `host-connected` | The host joined someone else meanwhile |
| `full` | The group already has `maxMembers` people |
| `not-allowed` | Your `canCreate` / `canJoin` said no |

## Stores

### Cloud Firestore (`app-invite-kit/firestore`)

`firestoreInviteStore(db, names?)` works on the free Spark plan (no Cloud Functions). Accepting runs in one transaction.

| Collection (default name) | Document | Holds |
|---|---|---|
| `invites` | the code | `hostId`, `createdAt`, `expiresAt`, `usedBy`, and `connectionId` for a group code |
| `connections` | random id | `hostId`, `guestId` (first guest), `memberIds`, `createdAt`, `invite` |
| `connectionMembers` | the user id | `connectionId`: one row per person, which keeps each person in one connection |

Pass `names` to use your own collection names. **Security rules are required**: copy the marked block from
[`docs/firestore.rules`](docs/firestore.rules) into your `firestore.rules`, and set `MAX_EXPIRY_MS` and `MAX_MEMBERS`
to your config (`MAX_EXPIRY_MS` is exactly `expiryMinutes × 60000`). The rules enforce on the server what the kit checks
on the phone: codes are single use, expire, are used only by others and only by joining, groups don't overflow, and each
person is in one connection that only they (or the end of the whole connection) can take them out of. A connection's
members can read it; other people only see whether someone is connected.

A code's times come from the phone's clock, which may be a little fast or slow. The rules accept a code whose
`createdAt` is within `CLOCK_MARGIN_MS` (10 minutes) of Google's time and whose lifetime is at most `MAX_EXPIRY_MS`, so a
code works for at most `MAX_EXPIRY_MS` + 10 minutes of server time. When the server refuses an accept that the phone
thought was fine, the store reads the code again and answers `'expired'`, `'used'`, `'not-found'` or `'full'`.

`firebase` is an optional peer dependency, needed only for this entry.

### Memory

`memoryInviteStore()` keeps everything in memory: for tests, demos and running without a database.

### Your own

Implement `InviteStore` (`src/types.ts`): `find`, `save`, `removeUnused`, `connectionOf`, `connectionIdOf`, `accept`,
`disconnect`, `removeMember`. `accept` must re-check and write atomically, so two guests racing for one code can't both win.

## Folder layout

```
src/
  index.ts             the core entry (no database code)
  types.ts             Invite, Connection, InviteStore, InviteConfig, InviteHooks, problems
  code.ts              makeCode (unbiased), normalizeCode, formatCode
  createInviteKit.ts   the rules
  memoryStore.ts       memoryInviteStore
  firestoreStore.ts    firestoreInviteStore (entry: app-invite-kit/firestore)
  kit.ts               KIT_NAME, KIT_VERSION
docs/firestore.rules   security rules for the Firestore store
tests/                 the rules with the memory store
firestore-tests/       the Firestore store against the emulator with docs/firestore.rules
```

## Testing

```bash
npm install
npm test               # rules with the memory store
npm run typecheck

cd firestore-tests     # optional: the real Firestore store and rules (needs Java)
npm install && npm test
```

To release: bump `version` in `package.json` and `KIT_VERSION` in `src/kit.ts`, add a note below, merge, then tag the merged commit.

## Versions

Every release is tagged (`v1.0.0`). Within a major version changes stay backward compatible: new options default to today's behavior.

### 2.0.0

Fixes from the 2026-11-21 review. Copy the new rules block from `docs/firestore.rules` when you update: the 2.0.0 store
needs it (leaving a group now also moves `guestId`, which the 1.0.0 rules refuse).

- A phone whose clock runs a few minutes fast can make codes again. The rules used to cap `expiresAt` at the server's
  time plus the expiry, so a fast clock was refused. They now check `createdAt` is within 10 minutes of the server's
  time and the lifetime is at most `MAX_EXPIRY_MS`. A phone whose clock is slow now gets `'expired'` instead of an error.
- A group code made for a connection that has ended no longer works (`'not-found'`). Before, the memory store paired the
  host with the guest in a new connection and the Firestore store said `'full'`. The host leaving also deletes their
  unused codes, and Firestore says `'full'` only when the group really is full.
- A member can no longer delete another member's `connectionMembers` row while the connection still lists them; rows go
  when their person leaves or the whole connection ends.
- A code can be marked used only in the same write that makes or joins the connection, so nobody can spoil a code
  without joining.
- When the first guest leaves a group, `guestId` moves to the next guest still in it.
- `createInviteKit` refuses a `config.alphabet` with lowercase letters, spaces, dashes or repeated letters, which made
  every code fail as `'not-found'`.

**Breaking:** re-copy the rules block; an alphabet that was silently broken now throws; group codes for an ended group
answer `'not-found'` instead of `'full'` (or a new connection, with the memory store).

### 1.0.0

First release: codes, create / check / accept / cancel / leave / disconnect, one connection per person, one-to-one or
groups (`maxMembers`), `canCreate` / `canJoin` / `onConnected` hooks, memory and Firestore stores, Firestore rules.
