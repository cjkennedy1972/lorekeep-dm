import { hash, verify, Algorithm } from '@node-rs/argon2';

const common = new Set([
  'password123456',
  '123456789012',
  'qwerty123456',
  'letmein123456',
  'passwordpassword',
]);
export function validPassword(password: string): boolean {
  return (
    password.length >= 12 &&
    password.length <= 1024 &&
    !common.has(password.toLowerCase())
  );
}
export function hashPassword(password: string): Promise<string> {
  return hash(password, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}
export function verifyPassword(
  hashValue: string,
  password: string,
): Promise<boolean> {
  return verify(hashValue, password);
}
