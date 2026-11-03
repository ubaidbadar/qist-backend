import { randomSecret } from './tokens';

const ALGORITHM = { algorithm: 'argon2id' } as const;

export const hashPassword = (password: string) => Bun.password.hash(password, ALGORITHM);

export const verifyPassword = (password: string, hash: string) => Bun.password.verify(password, hash);

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same time as a real check when the email is unknown, so response times don't reveal which
 * emails have accounts. Always false.
 */
export async function verifyAgainstDummy(password: string) {
  dummyHash ??= hashPassword(randomSecret());
  await verifyPassword(password, await dummyHash);
  return false;
}
