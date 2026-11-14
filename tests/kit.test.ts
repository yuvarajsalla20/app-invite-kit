import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createInviteKit, formatCode, KIT_NAME, KIT_VERSION, makeCode, memoryInviteStore, normalizeCode, DEFAULT_ALPHABET } from '../src';

/** Predictable "random" bytes: 0, 1, 2 … so codes are ABCDEF, GHJKMN … */
const counter = () => {
  let n = 0;
  return (b: Uint8Array) => b.map(() => n++ % 256);
};

describe('codes', () => {
  it('are the asked length, from the alphabet, with no look-alikes', () => {
    const code = makeCode(counter(), 6);
    expect(code).toHaveLength(6);
    expect([...code].every((ch) => DEFAULT_ALPHABET.includes(ch))).toBe(true);
    expect(DEFAULT_ALPHABET).not.toMatch(/[0O1IL]/);
  });

  it('skip bytes that would favour some letters', () => {
    // 248..255 are above the fair limit for a 31-letter alphabet (248 = 8 × 31), so they are skipped.
    const bytes = [250, 255, 0, 31, 62, 248, 1, 2, 3];
    let i = 0;
    expect(makeCode((b) => b.map(() => bytes[i++ % bytes.length]!), 6)).toBe('AAAB' + 'CD');
  });

  it('read the same however they are typed', () => {
    expect(normalizeCode(' k7q-2mx ')).toBe('K7Q2MX');
    expect(formatCode('K7Q2MX')).toBe('K7Q-2MX');
  });

  it('refuse silly settings', () => {
    expect(() => makeCode(counter(), 3)).toThrow();
    expect(() => makeCode(counter(), 6, 'A')).toThrow();
  });
});

describe('invites', () => {
  let time = 1_000_000;
  let store = memoryInviteStore();
  let kit = createInviteKit({ store, config: { expiryMinutes: 30 }, random: counter(), now: () => time });
  beforeEach(() => {
    time = 1_000_000;
    store = memoryInviteStore();
    kit = createInviteKit({ store, config: { expiryMinutes: 30 }, random: counter(), now: () => time });
  });

  it('expiry comes from config and must be set', () => {
    expect(() => createInviteKit({ store, config: { expiryMinutes: 0 }, random: counter() })).toThrow();
  });

  it('a code connects host and guest, once', async () => {
    const made = await kit.create('host');
    if (!made.ok) throw new Error();
    expect(made.invite.expiresAt - made.invite.createdAt).toBe(30 * 60_000);
    expect(await kit.check(made.invite.code.toLowerCase(), 'guest')).toMatchObject({ ok: true });
    const joined = await kit.accept(made.invite.code, 'guest');
    expect(joined).toMatchObject({ ok: true, connection: { hostId: 'host', guestId: 'guest' } });
    expect(await kit.accept(made.invite.code, 'third')).toEqual({ ok: false, problem: 'used' });
  });

  it('a code stops working when it expires', async () => {
    const made = await kit.create('host');
    if (!made.ok) throw new Error();
    time += 29 * 60_000;
    expect(kit.minutesLeft(made.invite)).toBe(1);
    time += 60_000;
    expect(await kit.accept(made.invite.code, 'guest')).toEqual({ ok: false, problem: 'expired' });
  });

  it('a new code replaces the host’s older unused one', async () => {
    const first = await kit.create('host');
    const second = await kit.create('host');
    if (!first.ok || !second.ok) throw new Error();
    expect(await kit.check(first.invite.code, 'guest')).toEqual({ ok: false, problem: 'not-found' });
    expect(await kit.check(second.invite.code, 'guest')).toMatchObject({ ok: true });
  });

  it('cancel stops the host’s code', async () => {
    const made = await kit.create('host');
    if (!made.ok) throw new Error();
    await kit.cancel('host');
    expect(await kit.check(made.invite.code, 'guest')).toEqual({ ok: false, problem: 'not-found' });
  });

  it('nobody can use their own code', async () => {
    const made = await kit.create('host');
    if (!made.ok) throw new Error();
    expect(await kit.accept(made.invite.code, 'host')).toEqual({ ok: false, problem: 'own-code' });
  });

  it('each person is in one connection at a time', async () => {
    const a = await kit.create('host');
    if (!a.ok) throw new Error();
    await kit.accept(a.invite.code, 'guest');
    // The connected host can't make a new code, and the connected guest can't join someone else.
    expect(await kit.create('host')).toEqual({ ok: false, problem: 'already-connected' });
    const b = await kit.create('other');
    if (!b.ok) throw new Error();
    expect(await kit.accept(b.invite.code, 'guest')).toEqual({ ok: false, problem: 'already-connected' });
  });

  it('a host who joined someone else meanwhile can’t be joined', async () => {
    const mine = await kit.create('host');
    const theirs = await kit.create('other');
    if (!mine.ok || !theirs.ok) throw new Error();
    await kit.accept(theirs.invite.code, 'host');
    expect(await kit.accept(mine.invite.code, 'guest')).toEqual({ ok: false, problem: 'host-connected' });
  });

  it('after a disconnect both can connect again with a new code', async () => {
    const a = await kit.create('host');
    if (!a.ok) throw new Error();
    const joined = await kit.accept(a.invite.code, 'guest');
    if (!joined.ok) throw new Error();
    await kit.disconnect(joined.connection.id);
    expect(await kit.connectionOf('guest')).toBeNull();
    const b = await kit.create('host');
    if (!b.ok) throw new Error();
    expect(await kit.accept(b.invite.code, 'guest')).toMatchObject({ ok: true });
  });

  it('unknown codes say so', async () => {
    expect(await kit.check('NOPE22', 'guest')).toEqual({ ok: false, problem: 'not-found' });
  });
});

describe('groups (maxMembers above 2)', () => {
  const setup = (maxMembers: number) => {
    const store = memoryInviteStore();
    return createInviteKit({ store, config: { expiryMinutes: 30, maxMembers }, random: counter(), now: () => 1_000 });
  };

  it('the host invites one guest per code until the group is full', async () => {
    const kit = setup(3);
    const a = await kit.create('host');
    if (!a.ok) throw new Error();
    await kit.accept(a.invite.code, 'g1');
    const b = await kit.create('host');
    if (!b.ok) throw new Error();
    expect(b.invite.connectionId).toBeTruthy();
    const joined = await kit.accept(b.invite.code, 'g2');
    expect(joined).toMatchObject({ ok: true, connection: { memberIds: ['host', 'g1', 'g2'] } });
    expect(await kit.create('host')).toEqual({ ok: false, problem: 'full' });
  });

  it('a guest leaving keeps the group; the host leaving ends it', async () => {
    const kit = setup(3);
    for (const g of ['g1', 'g2']) {
      const c = await kit.create('host');
      if (!c.ok) throw new Error();
      await kit.accept(c.invite.code, g);
    }
    await kit.leave('g2');
    expect((await kit.connectionOf('host'))?.memberIds).toEqual(['host', 'g1']);
    await kit.leave('host');
    expect(await kit.connectionOf('g1')).toBeNull();
  });

  it('a guest cannot invite others into the host’s group', async () => {
    const kit = setup(3);
    const c = await kit.create('host');
    if (!c.ok) throw new Error();
    await kit.accept(c.invite.code, 'g1');
    expect(await kit.create('g1')).toEqual({ ok: false, problem: 'already-connected' });
  });

  it('refuses a group size below 2', () => {
    expect(() => setup(1)).toThrow();
  });
});

describe('the app’s own checks', () => {
  it('canCreate and canJoin can refuse; onConnected hears about joins', async () => {
    const joined: string[] = [];
    const kit = createInviteKit({
      store: memoryInviteStore(),
      config: { expiryMinutes: 30 },
      random: counter(),
      hooks: { canCreate: (id) => id !== 'free-user', canJoin: async (id) => id !== 'blocked', onConnected: (c) => joined.push(c.guestId) },
    });
    expect(await kit.create('free-user')).toEqual({ ok: false, problem: 'not-allowed' });
    const c = await kit.create('host');
    if (!c.ok) throw new Error();
    expect(await kit.accept(c.invite.code, 'blocked')).toEqual({ ok: false, problem: 'not-allowed' });
    expect(await kit.accept(c.invite.code, 'guest')).toMatchObject({ ok: true });
    expect(joined).toEqual(['guest']);
  });

  it('leave in a one-to-one connection ends it for both', async () => {
    const kit = createInviteKit({ store: memoryInviteStore(), config: { expiryMinutes: 30 }, random: counter() });
    const c = await kit.create('host');
    if (!c.ok) throw new Error();
    await kit.accept(c.invite.code, 'guest');
    await kit.leave('guest');
    expect(await kit.connectionOf('host')).toBeNull();
  });

  it('formatCode groups any length', () => {
    expect(formatCode('ABCDEFGH', 4, ' ')).toBe('ABCD EFGH');
  });
});

describe('kit info', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect([KIT_NAME, KIT_VERSION]).toEqual([pkg.name, pkg.version]);
  });
});
