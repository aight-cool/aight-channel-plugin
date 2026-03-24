import { describe, expect, it } from "bun:test";
import { createRateLimiter } from "../utils";
import { LIMITS } from "../protocol";

describe("rate limiter", () => {
  it("allows messages under the limit", () => {
    const limiter = createRateLimiter();
    const now = Date.now();
    for (let i = 0; i < LIMITS.MAX_MESSAGES_PER_MINUTE; i++) {
      expect(limiter.allow(now + i)).toBe(true);
    }
  });

  it("rejects messages over the limit", () => {
    const limiter = createRateLimiter();
    const now = Date.now();

    for (let i = 0; i < LIMITS.MAX_MESSAGES_PER_MINUTE; i++) {
      limiter.allow(now + i);
    }

    expect(limiter.allow(now + LIMITS.MAX_MESSAGES_PER_MINUTE)).toBe(false);
  });

  it("allows messages again after the window expires", () => {
    const limiter = createRateLimiter();
    const now = Date.now();

    for (let i = 0; i < LIMITS.MAX_MESSAGES_PER_MINUTE; i++) {
      limiter.allow(now + i);
    }

    expect(limiter.allow(now + 100)).toBe(false);
    expect(limiter.allow(now + 61_000)).toBe(true);
  });

  it("slides the window correctly", () => {
    const limiter = createRateLimiter();
    const now = Date.now();

    for (let i = 0; i < 10; i++) limiter.allow(now);
    for (let i = 0; i < 20; i++) limiter.allow(now + 30_000);

    expect(limiter.allow(now + 30_001)).toBe(false);
    expect(limiter.allow(now + 61_000)).toBe(true);
  });

  it("handles rapid bursts", () => {
    const limiter = createRateLimiter();
    const now = Date.now();
    let allowed = 0;
    let rejected = 0;

    for (let i = 0; i < 100; i++) {
      if (limiter.allow(now)) allowed++;
      else rejected++;
    }

    expect(allowed).toBe(LIMITS.MAX_MESSAGES_PER_MINUTE);
    expect(rejected).toBe(100 - LIMITS.MAX_MESSAGES_PER_MINUTE);
  });
});
