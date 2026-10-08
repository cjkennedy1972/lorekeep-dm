import { inspect } from 'node:util';

/** Holds a credential so it cannot leak via logging, JSON or string coercion. */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return '[REDACTED]';
  }
  toJSON(): string {
    return '[REDACTED]';
  }
  [inspect.custom](): string {
    return '[REDACTED]';
  }
}
