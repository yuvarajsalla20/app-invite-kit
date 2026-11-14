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

## Quick start

```bash
npm install "app-invite-kit@git+https://github.com/yuvarajsalla20/app-invite-kit.git#v1.0.0"
```

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
| `config.alphabet` | no | Letters a code is made from. Default `ABCDEFGHJKMNPQRSTUVWXYZ23456789` |
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
| `connectionOf(userId)` | The person's own connection `{ id, hostId, guestId, memberIds, createdAt }`, or `null` |
| `leave(userId)` | One-to-one, or the host leaving: the connection ends for everyone. A guest in a group: just that guest goes |
| `disconnect(connectionId)` | Ends the connection for everyone |
| `minutesLeft(invite)` | Minutes left on a code, rounded up |
| `formatCode(code, group?, separator?)` (a function, imported on its own) | `K7Q2MX` → `K7Q-2MX` |

### Problems

| `problem` | When |
|---|---|
| `not-found` | No such code: a typo, cancelled, or replaced by a newer code |
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
to your config. The rules enforce on the server what the kit checks on the phone: codes are single use, expire, are
used only by others, groups don't overflow, and each person is in one connection. A connection's members can read it;
other people only see whether someone is connected.

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

## Versions

Every release is tagged (`v1.0.0`). Pin a tag or its commit SHA in your app. Within a major version changes stay
backward compatible: new options default to today's behavior.

### 1.0.0

First release: codes, create / check / accept / cancel / leave / disconnect, one connection per person, one-to-one or
groups (`maxMembers`), `canCreate` / `canJoin` / `onConnected` hooks, memory and Firestore stores, Firestore rules.
