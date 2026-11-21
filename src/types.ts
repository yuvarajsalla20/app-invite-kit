/** A code one person (the host) makes for one other person (the guest) to join them. */
export interface Invite {
  code: string;
  hostId: string;
  /** Milliseconds since 1970. */
  createdAt: number;
  expiresAt: number;
  /** Set once, when a guest accepts. A used code never works again. */
  usedBy: string | null;
  /** Set when the host is already in a group with room left: the guest joins that connection instead of starting one. */
  connectionId?: string | null;
}

/** People joined by accepted invites: the host and one or more guests (one with the default maxMembers of 2). */
export interface Connection {
  id: string;
  hostId: string;
  /** The first guest still in it (it moves to the next guest when that one leaves). With maxMembers 2 this is the only one. */
  guestId: string;
  /** Everyone in it, host first. */
  memberIds: string[];
  createdAt: number;
}

/** Why a code can't be used, so the app can say it in its own words. */
export type InviteProblem =
  | 'not-found' // no such code (typo, or the host made a newer one)
  | 'expired'
  | 'used'
  | 'own-code' // the host typed their own code
  | 'host-connected' // the host joined someone else meanwhile
  | 'already-connected' // the guest is already in a connection
  | 'full' // the host's connection already has maxMembers people
  | 'not-allowed'; // the app's own canCreate / canJoin check said no

export type CheckResult = { ok: true; invite: Invite } | { ok: false; problem: InviteProblem };
export type AcceptResult = { ok: true; connection: Connection } | { ok: false; problem: InviteProblem };
export type CreateResult = { ok: true; invite: Invite } | { ok: false; problem: 'already-connected' | 'full' | 'not-allowed' };

/**
 * Where invites and connections live (Firestore, memory in tests …). The kit never talks to a database directly.
 * `accept` must be atomic: it marks the invite used and records the connection together, or does nothing.
 */
export interface InviteStore {
  find(code: string): Promise<Invite | null>;
  save(invite: Invite): Promise<void>;
  /** Deletes the host's unused codes, so only the newest works. */
  removeUnused(hostId: string): Promise<void>;
  /** The connection this person is in, or null. Called only for the signed-in person themselves. */
  connectionOf(userId: string): Promise<Connection | null>;
  /** Only the id of the connection someone is in, or null. Used for other people, so a store can keep their connection private. */
  connectionIdOf(userId: string): Promise<string | null>;
  /**
   * Atomically: re-check the invite is unused and unexpired, the guest is free and (for a group) there is room, then mark
   * it used and save the connection: a new one, or the guest added to `invite.connectionId`.
   */
  accept(code: string, guestId: string, now: number, maxMembers: number): Promise<AcceptResult>;
  /** Ends the connection for everyone in it. */
  disconnect(connectionId: string): Promise<void>;
  /** Takes one guest out of a group connection; the rest stay connected. */
  removeMember(connectionId: string, userId: string): Promise<void>;
}

export interface InviteConfig {
  /** How long a code works, in minutes. The app passes it from its own config (no default on purpose). */
  expiryMinutes: number;
  /** Code length. Default 6. */
  length?: number;
  /** Letters a code is made from. Default: capitals and digits without look-alikes (no 0 O 1 I L). */
  alphabet?: string;
  /** People in one connection, host included. Default 2 (one-to-one). A higher number makes groups: the host makes one code per guest. */
  maxMembers?: number;
}

/** The app's own rules, checked before the kit's (VIP only, age checks, blocked people …). Resolve false to refuse with 'not-allowed'. */
export interface InviteHooks {
  canCreate?(hostId: string): boolean | Promise<boolean>;
  canJoin?(guestId: string, invite: Invite): boolean | Promise<boolean>;
  /** Called after a guest joined, on the guest's device. */
  onConnected?(connection: Connection): void;
}
