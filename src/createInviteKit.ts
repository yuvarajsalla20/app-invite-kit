import { DEFAULT_ALPHABET, DEFAULT_LENGTH, makeCode, normalizeCode, type RandomBytes } from './code';
import type { AcceptResult, CheckResult, Connection, CreateResult, Invite, InviteConfig, InviteHooks, InviteStore } from './types';

export interface InviteKitOptions {
  store: InviteStore;
  config: InviteConfig;
  random: RandomBytes;
  /** The app's own checks and callback. All optional. */
  hooks?: InviteHooks;
  /** The time now, in milliseconds. Default Date.now (tests pass their own). */
  now?: () => number;
}

const MINUTE = 60_000;
export const DEFAULT_MAX_MEMBERS = 2;

/**
 * Make, check and accept invite codes. Rules: a code works once, until it expires; each person is in one connection at
 * a time; a connection holds at most `maxMembers` people (2 by default: one-to-one).
 */
export function createInviteKit({ store, config, random, hooks = {}, now = Date.now }: InviteKitOptions) {
  if (!(config.expiryMinutes > 0)) throw new Error('app-invite-kit: config.expiryMinutes must be more than 0.');
  const maxMembers = config.maxMembers ?? DEFAULT_MAX_MEMBERS;
  if (!Number.isInteger(maxMembers) || maxMembers < 2) throw new Error('app-invite-kit: config.maxMembers must be a whole number of 2 or more.');
  const length = config.length ?? DEFAULT_LENGTH;
  const alphabet = config.alphabet ?? DEFAULT_ALPHABET;
  // Typed codes are made comparable with normalizeCode (capitals, no spaces or dashes), so a code made from any other
  // letter could never be found again.
  if (alphabet !== normalizeCode(alphabet) || new Set(alphabet).size !== alphabet.length)
    throw new Error('app-invite-kit: config.alphabet must be capitals and digits, each once, with no spaces or dashes.');

  /** The host's connection that still has room, or a reason the host can't invite anyone. */
  const hostRoom = async (hostId: string): Promise<{ ok: true; connection: Connection | null } | { ok: false; problem: 'already-connected' | 'full' }> => {
    const c = await store.connectionOf(hostId);
    if (!c) return { ok: true, connection: null };
    if (maxMembers === 2 || c.hostId !== hostId) return { ok: false, problem: 'already-connected' };
    if (c.memberIds.length >= maxMembers) return { ok: false, problem: 'full' };
    return { ok: true, connection: c };
  };

  const problemWith = async (invite: Invite | null, guestId: string, at: number): Promise<CheckResult> => {
    if (!invite) return { ok: false, problem: 'not-found' };
    if (invite.usedBy) return { ok: false, problem: 'used' };
    if (at >= invite.expiresAt) return { ok: false, problem: 'expired' };
    if (invite.hostId === guestId) return { ok: false, problem: 'own-code' };
    if (await store.connectionIdOf(guestId)) return { ok: false, problem: 'already-connected' };
    const hostIn = await store.connectionIdOf(invite.hostId);
    // A group code made for a connection that has since ended (or that the host has left) no longer leads anywhere.
    if (invite.connectionId && hostIn !== invite.connectionId) return { ok: false, problem: 'not-found' };
    if (hostIn && hostIn !== invite.connectionId) return { ok: false, problem: 'host-connected' };
    // Room in a group is re-checked by the store when accepting (the guest can't see the group's members yet).
    if (hooks.canJoin && !(await hooks.canJoin(guestId, invite))) return { ok: false, problem: 'not-allowed' };
    return { ok: true, invite };
  };

  return {
    maxMembers,

    /** A new code for the host. Their older unused codes stop working. */
    async create(hostId: string): Promise<CreateResult> {
      const room = await hostRoom(hostId);
      if (!room.ok) return room;
      if (hooks.canCreate && !(await hooks.canCreate(hostId))) return { ok: false, problem: 'not-allowed' };
      await store.removeUnused(hostId);
      for (let tries = 0; tries < 5; tries++) {
        const code = makeCode(random, length, alphabet);
        if (await store.find(code)) continue; // taken: try another
        const at = now();
        const invite: Invite = { code, hostId, createdAt: at, expiresAt: at + config.expiryMinutes * MINUTE, usedBy: null };
        if (room.connection) invite.connectionId = room.connection.id;
        await store.save(invite);
        return { ok: true, invite };
      }
      throw new Error('app-invite-kit: could not find a free code. Use a longer code length.');
    },

    /** Whether the guest can use this code now, without using it. For showing who invited them before Accept. */
    async check(typed: string, guestId: string): Promise<CheckResult> {
      return problemWith(await store.find(normalizeCode(typed)), guestId, now());
    },

    /** Uses the code. The store re-checks everything atomically, so two guests can't both win. */
    async accept(typed: string, guestId: string): Promise<AcceptResult> {
      const code = normalizeCode(typed);
      const at = now();
      const first = await problemWith(await store.find(code), guestId, at);
      if (!first.ok) return first;
      const result = await store.accept(code, guestId, at, maxMembers);
      if (result.ok) hooks.onConnected?.(result.connection);
      return result;
    },

    /** Stops the host's unused codes from working. */
    cancel: (hostId: string) => store.removeUnused(hostId),

    /** The connection this person is in, or null. */
    connectionOf: (userId: string) => store.connectionOf(userId),

    /** Ends a connection for everyone in it. Each can then make or accept a new code. */
    disconnect: (connectionId: string) => store.disconnect(connectionId),

    /**
     * One person leaves. In a one-to-one connection, or when the host leaves, or when only one person would be left,
     * the whole connection ends; otherwise just that guest goes.
     */
    async leave(userId: string): Promise<void> {
      const c = await store.connectionOf(userId);
      if (!c) return;
      if (userId === c.hostId) {
        // The host's unused group codes were made for this connection: they stop working with it.
        await store.disconnect(c.id);
        return store.removeUnused(userId);
      }
      if (c.memberIds.length <= 2) return store.disconnect(c.id);
      return store.removeMember(c.id, userId);
    },

    /** Minutes left on a code, rounded up (0 once expired). For "Expires in 12 min". */
    minutesLeft: (invite: Invite) => Math.max(0, Math.ceil((invite.expiresAt - now()) / MINUTE)),
  };
}

export type InviteKit = ReturnType<typeof createInviteKit>;
