import { arrayUnion, collection, deleteDoc, doc, getDoc, getDocs, query, runTransaction, setDoc, where, type Firestore } from 'firebase/firestore';
import type { AcceptResult, Connection, Invite, InviteProblem, InviteStore } from './types';

/** Collection names, so each app keeps its own. */
export interface FirestoreInviteNames {
  /** invites/{code}: { hostId, createdAt, expiresAt, usedBy } */
  invites: string;
  /** connections/{id}: { hostId, guestId, createdAt, memberIds } */
  connections: string;
  /** connectionMembers/{userId}: { connectionId }. One per person: this is what keeps each person in one connection. */
  members: string;
}

/**
 * How far a phone's clock may be from Google's. The security rules accept an invite whose createdAt is within this of
 * the server's time (CLOCK_MARGIN_MS in docs/firestore.rules), and a refusal this close to expiresAt is read as expired.
 */
export const CLOCK_MARGIN_MS = 10 * 60_000;

export const DEFAULT_FIRESTORE_NAMES: FirestoreInviteNames = { invites: 'invites', connections: 'connections', members: 'connectionMembers' };

const toInvite = (code: string, d: Record<string, unknown>): Invite => ({
  code,
  hostId: String(d.hostId),
  createdAt: Number(d.createdAt),
  expiresAt: Number(d.expiresAt),
  usedBy: typeof d.usedBy === 'string' ? d.usedBy : null,
  ...(typeof d.connectionId === 'string' ? { connectionId: d.connectionId } : {}),
});

const toConnection = (id: string, d: Record<string, unknown>): Connection => ({
  id,
  hostId: String(d.hostId),
  guestId: String(d.guestId),
  memberIds: Array.isArray(d.memberIds) ? d.memberIds.map(String) : [String(d.hostId), String(d.guestId)],
  createdAt: Number(d.createdAt),
});

/**
 * An InviteStore on Cloud Firestore (works on the free Spark plan: no Cloud Functions). Accepting runs in one
 * transaction. Pair it with the security rules in docs/firestore.rules, which enforce the same rules on the server.
 */
export function firestoreInviteStore(db: Firestore, names: Partial<FirestoreInviteNames> = {}): InviteStore {
  const n = { ...DEFAULT_FIRESTORE_NAMES, ...names };
  const inviteRef = (code: string) => doc(db, n.invites, code);
  const memberRef = (uid: string) => doc(db, n.members, uid);

  const connectionOf = async (userId: string): Promise<Connection | null> => {
    const m = await getDoc(memberRef(userId));
    const id = m.exists() ? (m.data().connectionId as string | undefined) : undefined;
    if (!id) return null;
    const c = await getDoc(doc(db, n.connections, id));
    return c.exists() ? toConnection(id, c.data()) : null;
  };

  const connectionIdOf = async (userId: string): Promise<string | null> => {
    const m = await getDoc(memberRef(userId));
    return m.exists() ? ((m.data().connectionId as string | undefined) ?? null) : null;
  };

  /** Why the server refused an accept that passed every check on the phone, or null when it can't be told. */
  const whyRefused = async (code: string, now: number): Promise<InviteProblem | null> => {
    const s = await getDoc(inviteRef(code));
    if (!s.exists()) return 'not-found';
    const invite = toInvite(code, s.data());
    if (invite.usedBy) return 'used';
    if (invite.connectionId) {
      const hostIn = await connectionIdOf(invite.hostId);
      if (hostIn !== invite.connectionId) return 'not-found';
      // The host is still in the group the code was made for. The guest can't read the group to count it, so a
      // refusal here is read as full, whatever time is left on the code: short codes (10 minutes or less) are always
      // within CLOCK_MARGIN_MS of expiry, and calling a full group expired would send the host to make a new code.
      return 'full';
    }
    // Nothing else explains it: the phone's clock is behind the server's, and on the server the code has run out.
    if (now >= invite.expiresAt - CLOCK_MARGIN_MS) return 'expired';
    return null;
  };

  return {
    async find(code) {
      const s = await getDoc(inviteRef(code));
      return s.exists() ? toInvite(code, s.data()) : null;
    },
    save: ({ code, ...rest }) => setDoc(inviteRef(code), rest),
    async removeUnused(hostId) {
      const mine = await getDocs(query(collection(db, n.invites), where('hostId', '==', hostId), where('usedBy', '==', null)));
      await Promise.all(mine.docs.map((d) => deleteDoc(d.ref)));
    },
    connectionOf,
    connectionIdOf,
    async accept(code, guestId, now, _maxMembers) {
      const result = await runTransaction(db, async (tx): Promise<AcceptResult> => {
        const s = await tx.get(inviteRef(code));
        if (!s.exists()) return { ok: false, problem: 'not-found' };
        const invite = toInvite(code, s.data());
        if (invite.usedBy) return { ok: false, problem: 'used' };
        if (now >= invite.expiresAt) return { ok: false, problem: 'expired' };
        if ((await tx.get(memberRef(guestId))).exists()) return { ok: false, problem: 'already-connected' };
        const hostRow = await tx.get(memberRef(invite.hostId));
        const hostIn = hostRow.exists() ? (hostRow.data().connectionId as string) : null;
        if (invite.connectionId && hostIn !== invite.connectionId) return { ok: false, problem: 'not-found' };
        if (hostIn && hostIn !== invite.connectionId) return { ok: false, problem: 'host-connected' };
        if (hostIn) {
          // A group: the guest joins the host's connection. The guest can't read it yet, so the security rules check
          // there is room (memberIds.size() <= MAX_MEMBERS); whyRefused below tells a full group from other refusals.
          tx.update(inviteRef(code), { usedBy: guestId });
          tx.update(doc(db, n.connections, hostIn), { memberIds: arrayUnion(guestId), invite: code });
          tx.set(memberRef(guestId), { connectionId: hostIn });
          return { ok: true, connection: { id: hostIn, hostId: invite.hostId, guestId: '', memberIds: [], createdAt: now } };
        }
        const ref = doc(collection(db, n.connections));
        const connection: Connection = { id: ref.id, hostId: invite.hostId, guestId, memberIds: [invite.hostId, guestId], createdAt: now };
        tx.update(inviteRef(code), { usedBy: guestId });
        tx.set(ref, { hostId: invite.hostId, guestId, createdAt: now, memberIds: connection.memberIds, invite: code });
        tx.set(memberRef(invite.hostId), { connectionId: ref.id });
        tx.set(memberRef(guestId), { connectionId: ref.id });
        return { ok: true, connection };
      }).catch(async (e: { code?: string }): Promise<AcceptResult> => {
        if (e?.code !== 'permission-denied') throw e;
        // Every check above passed on this phone, but the server said no. Work out why from what the guest can read.
        const problem = await whyRefused(code, now);
        if (problem) return { ok: false, problem };
        throw e;
      });
      // Now a member, the guest can read the whole connection.
      if (result.ok && !result.connection.memberIds.length) return { ok: true, connection: (await connectionOf(guestId)) ?? result.connection };
      return result;
    },
    disconnect: (connectionId) =>
      runTransaction(db, async (tx) => {
        const ref = doc(db, n.connections, connectionId);
        const c = await tx.get(ref);
        if (!c.exists()) return;
        for (const uid of toConnection(connectionId, c.data()).memberIds) tx.delete(memberRef(uid));
        tx.delete(ref);
      }),
    removeMember: (connectionId, userId) =>
      runTransaction(db, async (tx) => {
        const ref = doc(db, n.connections, connectionId);
        const c = await tx.get(ref);
        tx.delete(memberRef(userId));
        if (!c.exists()) return;
        const before = toConnection(connectionId, c.data());
        const memberIds = before.memberIds.filter((m) => m !== userId);
        // guestId names the first guest still in the connection.
        const guestId = before.guestId === userId ? (memberIds.find((m) => m !== before.hostId) ?? '') : before.guestId;
        tx.update(ref, before.guestId === userId ? { memberIds, guestId } : { memberIds });
      }),
  };
}
