import { arrayRemove, arrayUnion, collection, deleteDoc, doc, getDoc, getDocs, query, runTransaction, setDoc, where, type Firestore } from 'firebase/firestore';
import type { AcceptResult, Connection, Invite, InviteStore } from './types';

/** Collection names, so each app keeps its own. */
export interface FirestoreInviteNames {
  /** invites/{code}: { hostId, createdAt, expiresAt, usedBy } */
  invites: string;
  /** connections/{id}: { hostId, guestId, createdAt, memberIds } */
  connections: string;
  /** connectionMembers/{userId}: { connectionId }. One per person: this is what keeps each person in one connection. */
  members: string;
}

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
 * transaction. Pair it with the security rules in docs/firestore-rules.md, which enforce the same rules on the server.
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
    async accept(code, guestId, now, maxMembers) {
      const result = await runTransaction(db, async (tx): Promise<AcceptResult> => {
        const s = await tx.get(inviteRef(code));
        if (!s.exists()) return { ok: false, problem: 'not-found' };
        const invite = toInvite(code, s.data());
        if (invite.usedBy) return { ok: false, problem: 'used' };
        if (now >= invite.expiresAt) return { ok: false, problem: 'expired' };
        if ((await tx.get(memberRef(guestId))).exists()) return { ok: false, problem: 'already-connected' };
        const hostRow = await tx.get(memberRef(invite.hostId));
        const hostIn = hostRow.exists() ? (hostRow.data().connectionId as string) : null;
        if (hostIn && hostIn !== invite.connectionId) return { ok: false, problem: 'host-connected' };
        if (hostIn) {
          // A group: the guest joins the host's connection. The guest can't read it yet, so the security rules check
          // there is room (memberIds.size() <= MAX_MEMBERS); a refusal there means the group is full.
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
      }).catch((e: { code?: string }) => {
        // Only a group join can be refused after every check above passed: the group filled up meanwhile.
        if (e?.code === 'permission-denied' && maxMembers > 2) return { ok: false, problem: 'full' } as AcceptResult;
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
        tx.delete(memberRef(userId));
        tx.update(doc(db, n.connections, connectionId), { memberIds: arrayRemove(userId) });
      }),
  };
}
