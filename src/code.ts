/** Capitals and digits that can't be mistaken for each other when read out or typed. */
export const DEFAULT_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const DEFAULT_LENGTH = 6;

/** Fills a byte array with secure random values (crypto.getRandomValues, expo-crypto …). */
export type RandomBytes = (bytes: Uint8Array) => Uint8Array;

/** A random code with every letter equally likely (bytes that would favour some letters are thrown away). */
export function makeCode(random: RandomBytes, length = DEFAULT_LENGTH, alphabet = DEFAULT_ALPHABET): string {
  if (alphabet.length < 2 || alphabet.length > 256) throw new Error('app-invite-kit: the alphabet needs 2 to 256 letters.');
  if (!Number.isInteger(length) || length < 4) throw new Error('app-invite-kit: a code needs at least 4 letters.');
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const b of random(new Uint8Array(length * 2))) {
      if (b < limit) out += alphabet[b % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** What people type, made comparable: capitals, no spaces or dashes. */
export const normalizeCode = (typed: string): string => typed.toUpperCase().replace(/[\s-]/g, '');

/** "K7Q2MX" shown as "K7Q-2MX" for reading out: groups of `group` letters (default 3) joined by `separator` (default "-"). */
export const formatCode = (code: string, group = 3, separator = '-'): string =>
  group > 0 && code.length > group ? (code.match(new RegExp(`.{1,${group}}`, 'g')) ?? [code]).join(separator) : code;
