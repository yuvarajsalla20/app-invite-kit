import type { AcceptResult, Connection, Invite, InviteStore } from './types';

/** An InviteStore kept in memory: for tests, and for an app running without a database. */
export function memoryInviteStore(): InviteStore & { invites: Map<string, Invite>; connections: Map<string, Connection> } {
  const invites = new Map<string, Invite>();
  const connections = new Map<string, Connection>();
  let next = 1;
  const connectionOf = async (userId: string) => [...connections.values()].find((c) => c.memberIds.includes(userId)) ?? null;
  return {
    invites,
    connections,
    find: async (code) => invites.get(code) ?? null,
    save: async (invite) => void invites.set(invite.code, { ...invite }),
    removeUnused: async (hostId) => {
      for (const [code, i] of invites) if (i.hostId === hostId && !i.usedBy) invites.delete(code);
    },
    connectionOf,
    connectionIdOf: async (userId) => (await connectionOf(userId))?.id ?? null,
    async accept(code, guestId, now, maxMembers): Promise<AcceptResult> {
      const invite = invites.get(code);
      if (!invite) return { ok: false, problem: 'not-found' };
      if (invite.usedBy) return { ok: false, problem: 'used' };
      if (now >= invite.expiresAt) return { ok: false, problem: 'expired' };
      if (await connectionOf(guestId)) return { ok: false, problem: 'already-connected' };
      const host = await connectionOf(invite.hostId);
      if (invite.connectionId && host?.id !== invite.connectionId) return { ok: false, problem: 'not-found' };
      if (host && host.id !== invite.connectionId) return { ok: false, problem: 'host-connected' };
      if (host && host.memberIds.length >= maxMembers) return { ok: false, problem: 'full' };
      invite.usedBy = guestId;
      if (host) {
        host.memberIds = [...host.memberIds, guestId];
        return { ok: true, connection: { ...host } };
      }
      const connection: Connection = { id: `c${next++}`, hostId: invite.hostId, guestId, memberIds: [invite.hostId, guestId], createdAt: now };
      connections.set(connection.id, connection);
      return { ok: true, connection: { ...connection } };
    },
    disconnect: async (id) => void connections.delete(id),
    removeMember: async (id, userId) => {
      const c = connections.get(id);
      if (!c) return;
      c.memberIds = c.memberIds.filter((m) => m !== userId);
      // guestId names the first guest still in the connection.
      if (c.guestId === userId) c.guestId = c.memberIds.find((m) => m !== c.hostId) ?? '';
    },
  };
}
