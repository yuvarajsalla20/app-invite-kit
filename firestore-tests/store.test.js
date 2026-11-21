// The Firestore store against the emulator with docs/firestore.rules. Run: cd firestore-tests && npm install && npm test (needs Java).
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { deleteDoc, doc, updateDoc } from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createInviteKit } from '../src/index.ts';
import { firestoreInviteStore } from '../src/firestoreStore.ts';

const rules = (max) => readFileSync(new URL('../docs/firestore.rules', import.meta.url), 'utf8').replace(/size\(\) (<|<=) 2\) ?\/\/ MAX_MEMBERS/g, (_m, op) => `size() ${op} ${max}) // MAX_MEMBERS`).replace(/size\(\) <= 2 \/\/ MAX_MEMBERS/g, `size() <= ${max} // MAX_MEMBERS`);
let n = 0;
const bytes = (b) => b.map(() => (n = (n * 7 + 13) % 248));

const setup = async (max) => {
  const env = await initializeTestEnvironment({ projectId: `demo-invite-${max}`, firestore: { rules: rules(max), host: '127.0.0.1', port: 8181 } });
  const db = (uid) => env.authenticatedContext(uid).firestore();
  // skewMs: how far this phone's clock is from the server's (the emulator runs on this machine's clock).
  const kit = (uid, { skewMs = 0, expiryMinutes = 30 } = {}) =>
    createInviteKit({ store: firestoreInviteStore(db(uid)), config: { expiryMinutes, maxMembers: max }, random: bytes, now: () => Date.now() + skewMs });
  return { env, kit, db };
};

describe('one-to-one through the real rules', async () => {
  const { env, kit, db } = await setup(2);
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

  it('a phone clock a few minutes fast can still make a code that works', async () => {
    const made = await kit('host', { skewMs: 3 * 60_000 }).create('host');
    expect(made.ok).toBe(true);
    expect(await kit('guest').accept(made.invite.code, 'guest')).toMatchObject({ ok: true });
  });

  it('a code that has run out on the server reads as expired on a phone whose clock is slow', async () => {
    const slow = { skewMs: -5 * 60_000, expiryMinutes: 1 };
    const made = await kit('host', slow).create('host');
    expect(made.ok).toBe(true);
    // On the slow phones the code still has a minute left; on the server it ran out four minutes ago.
    expect(await kit('guest', slow).accept(made.invite.code, 'guest')).toEqual({ ok: false, problem: 'expired' });
  });

  it('a code made with a lifetime longer than the rules allow is refused', async () => {
    await expect(kit('host', { expiryMinutes: 31 }).create('host')).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('nobody can spoil a code by marking it used without joining', async () => {
    const made = await kit('host').create('host');
    await assertFails(updateDoc(doc(db('stranger'), 'invites', made.invite.code), { usedBy: 'stranger' }));
    expect(await kit('guest').accept(made.invite.code, 'guest')).toMatchObject({ ok: true });
  });
});

describe('groups through the real rules', async () => {
  const { env, kit, db } = await setup(3);
  afterAll(() => env.cleanup());
  beforeEach(() => env.clearFirestore());

  const join = async (g) => {
    const c = await kit('host').create('host');
    return kit(g).accept(c.invite.code, g);
  };

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

  it('a code made for a group that the host has left no longer works', async () => {
    await join('g1');
    const b = await kit('host').create('host');
    await kit('host').leave('host');
    expect(await kit('g2').accept(b.invite.code, 'g2')).toEqual({ ok: false, problem: 'not-found' });
  });

  it('a code made for a group that ended without the host no longer works', async () => {
    await join('g1');
    const b = await kit('host').create('host');
    await kit('g1').leave('g1'); // only the host would be left, so the connection ends
    expect(await kit('g2').accept(b.invite.code, 'g2')).toEqual({ ok: false, problem: 'not-found' });
  });

  it('a guest cannot free another member while the group still lists them', async () => {
    await join('g1');
    await assertFails(deleteDoc(doc(db('g1'), 'connectionMembers', 'host')));
    await join('g2');
    await assertFails(deleteDoc(doc(db('g1'), 'connectionMembers', 'g2')));
    // Leaving properly still works for a guest and for the host.
    await kit('g2').leave('g2');
    await kit('host').leave('host');
    expect(await kit('g1').connectionOf('g1')).toBeNull();
    await assertSucceeds(kit('host').create('host'));
  });

  it('a code for a group that filled up meanwhile reads as full', async () => {
    await join('g1');
    const b = await kit('host').create('host');
    // A second open code for the same group (the kit keeps only the newest, so it is written straight to the store).
    const c = { ...b.invite, code: 'ZZZZZZ' };
    await firestoreInviteStore(db('host')).save(c);
    expect(await kit('g2').accept(b.invite.code, 'g2')).toMatchObject({ ok: true });
    expect(await kit('g3').accept(c.code, 'g3')).toEqual({ ok: false, problem: 'full' });
  });

  it('when the first guest leaves, the next guest becomes guestId', async () => {
    await join('g1');
    await join('g2');
    await kit('g1').leave('g1');
    expect(await kit('host').connectionOf('host')).toMatchObject({ guestId: 'g2', memberIds: ['host', 'g2'] });
  });
});
