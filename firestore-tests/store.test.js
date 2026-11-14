// The Firestore store against the emulator with docs/firestore.rules. Run: cd firestore-tests && npm install && npm test (needs Java).
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createInviteKit } from '../src/index.ts';
import { firestoreInviteStore } from '../src/firestoreStore.ts';

const rules = (max) => readFileSync(new URL('../docs/firestore.rules', import.meta.url), 'utf8').replace(/size\(\) (<|<=) 2\) ?\/\/ MAX_MEMBERS/g, (_m, op) => `size() ${op} ${max}) // MAX_MEMBERS`).replace(/size\(\) <= 2 \/\/ MAX_MEMBERS/g, `size() <= ${max} // MAX_MEMBERS`);
let n = 0;
const bytes = (b) => b.map(() => (n = (n * 7 + 13) % 248));

const setup = async (max) => {
  const env = await initializeTestEnvironment({ projectId: `demo-invite-${max}`, firestore: { rules: rules(max), host: '127.0.0.1', port: 8181 } });
  const kit = (uid) => createInviteKit({ store: firestoreInviteStore(env.authenticatedContext(uid).firestore()), config: { expiryMinutes: 30, maxMembers: max }, random: bytes });
  return { env, kit };
};

describe('one-to-one through the real rules', async () => {
  const { env, kit } = await setup(2);
  afterAll(() => env.cleanup());
  beforeEach(() => env.clearFirestore());

  it('create, check, accept, second guest refused, disconnect, reconnect', async () => {
    const made = await kit('host').create('host');
    expect(made.ok).toBe(true);
    expect(await kit('guest').check(made.invite.code, 'guest')).toMatchObject({ ok: true });
    expect(await kit('guest').accept(made.invite.code, 'guest')).toMatchObject({ ok: true, connection: { hostId: 'host', guestId: 'guest' } });
    expect(await kit('other').accept(made.invite.code, 'other')).toEqual({ ok: false, problem: 'used' });
    expect(await kit('host').create('host')).toEqual({ ok: false, problem: 'already-connected' });
    await kit('guest').leave('guest');
    expect(await kit('host').connectionOf('host')).toBeNull();
    const again = await kit('host').create('host');
    expect(await kit('other').accept(again.invite.code, 'other')).toMatchObject({ ok: true });
  });

  it('a new code replaces the old one', async () => {
    const a = await kit('host').create('host');
    await kit('host').create('host');
    expect(await kit('guest').check(a.invite.code, 'guest')).toEqual({ ok: false, problem: 'not-found' });
  });
});

describe('groups through the real rules', async () => {
  const { env, kit } = await setup(3);
  afterAll(() => env.cleanup());

  it('two guests join one host, the third code is refused, a guest leaves', async () => {
    for (const g of ['g1', 'g2']) {
      const c = await kit('host').create('host');
      expect(await kit(g).accept(c.invite.code, g)).toMatchObject({ ok: true });
    }
    expect(await kit('host').create('host')).toEqual({ ok: false, problem: 'full' });
    await kit('g2').leave('g2');
    expect((await kit('host').connectionOf('host')).memberIds).toEqual(['host', 'g1']);
    await kit('host').leave('host');
    expect(await kit('g1').connectionOf('g1')).toBeNull();
  });
});
