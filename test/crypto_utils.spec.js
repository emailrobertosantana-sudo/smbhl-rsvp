import { describe, it, expect } from 'vitest';
import { hmac, same } from '../src/crypto_utils.js';

describe('hmac()', () => {
  it('throws when the secret is undefined', async () => {
    await expect(hmac(undefined, 'some-message')).rejects.toThrow();
  });

  it('throws when the secret is an empty string', async () => {
    await expect(hmac('', 'some-message')).rejects.toThrow();
  });

  it('throws when the secret is null', async () => {
    await expect(hmac(null, 'some-message')).rejects.toThrow();
  });

  it('produces a signature when given a real secret', async () => {
    const sig = await hmac('a-real-secret', 'some-message');
    expect(typeof sig).toBe('string');
    expect(sig.length).toBe(32);
  });

  it('produces stable, distinct signatures for different secrets', async () => {
    const a = await hmac('secret-a', 'same-message');
    const b = await hmac('secret-b', 'same-message');
    expect(a).not.toBe(b);
  });
});

describe('same()', () => {
  it('returns true for equal strings', () => {
    expect(same('abc123', 'abc123')).toBe(true);
  });

  it('returns false for different strings', () => {
    expect(same('abc123', 'abc124')).toBe(false);
  });
});
