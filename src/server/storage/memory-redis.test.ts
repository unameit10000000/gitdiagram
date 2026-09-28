import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  memoryRedisCommand,
  memoryRedisEval,
  resetMemoryRedisForTests,
} from "~/server/storage/memory-redis";

const REGISTER_ACTIVE_SCRIPT = `
if not redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2], "NX") then
  return 0
end
local pending = redis.call("GET", KEYS[2])
if pending == ARGV[1] then
  redis.call("SET", KEYS[2], "1", "EX", ARGV[3])
elseif pending then
  redis.call("DEL", KEYS[2])
end
return 1
`;

const MARK_CANCELLED_SCRIPT = `
local active = redis.call("GET", KEYS[1])
if active == ARGV[1] then
  redis.call("SET", KEYS[2], "1", "EX", ARGV[2])
  return 1
end
if active then
  return 0
end
redis.call("SET", KEYS[2], ARGV[1], "EX", ARGV[3])
return 0
`;

const RATE_LIMIT_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local windowRemaining = tonumber(ARGV[2])

local count = redis.call("INCR", key)
if count == 1 then
  redis.call("EXPIRE", key, windowRemaining)
end

local ttl = redis.call("TTL", key)
if ttl < 0 then
  redis.call("EXPIRE", key, windowRemaining)
  ttl = windowRemaining
end

if count > limit then
  return {0, ttl}
end

return {1, ttl}
`;

const CLAIM_SCRIPT = `
if KEYS[3] and tonumber(redis.call("GET", KEYS[3]) or "0") >= tonumber(ARGV[4]) then
  return 0
end
if tonumber(redis.call("GET", KEYS[2]) or "0") >= tonumber(ARGV[2]) then
  if redis.call("EXISTS", KEYS[1]) == 1 then
    return 0
  end
  if redis.call("INCR", KEYS[2]) == tonumber(ARGV[2]) + 1 then
    return -1
  end
  return -2
end
if not redis.call("SET", KEYS[1], "1", "NX", "EX", ARGV[1]) then
  return 0
end
for i = 2, #KEYS do
  if redis.call("INCR", KEYS[i]) == 1 then
    redis.call("EXPIRE", KEYS[i], ARGV[3])
  end
end
return 1
`;

const UPSERT_PENDING_SCRIPT = `
local existing = redis.call("HGET", KEYS[1], ARGV[1])
if existing then
  local separator = string.find(existing, "|", 1, true)
  if separator then
    local existing_sort_key = string.sub(existing, 1, separator - 1)
    if existing_sort_key >= ARGV[2] then
      return 0
    end
  end
end
redis.call("HSET", KEYS[1], ARGV[1], ARGV[3])
return 1
`;

const REFUND_SCRIPT = `
for _, key in ipairs(KEYS) do
  if tonumber(redis.call("GET", key) or "0") > 0 then
    redis.call("DECR", key)
  end
end
return 0
`;

const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const WRITE_CONTROLS_SCRIPT = `
local set = tonumber(ARGV[1])
if set > 0 then
  redis.call("HSET", KEYS[1], unpack(ARGV, 2, 1 + set))
end
if #ARGV > 1 + set then
  redis.call("HDEL", KEYS[1], unpack(ARGV, 2 + set))
end
return 1
`;

describe("memoryRedisCommand", () => {
  beforeEach(() => {
    resetMemoryRedisForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    resetMemoryRedisForTests();
    vi.useRealTimers();
  });

  it("sets, gets and expires string values", () => {
    expect(memoryRedisCommand(["SET", "a", "1"])).toBe("OK");
    expect(memoryRedisCommand(["GET", "a"])).toBe("1");
    expect(memoryRedisCommand(["TTL", "a"])).toBe(-1);
    expect(memoryRedisCommand(["SET", "b", "2", "EX", 60])).toBe("OK");
    expect(memoryRedisCommand(["TTL", "b"])).toBe(60);
    vi.advanceTimersByTime(61_000);
    expect(memoryRedisCommand(["GET", "b"])).toBeNull();
  });

  it("honours NX and INCR", () => {
    memoryRedisCommand(["SET", "k", "1"]);
    expect(memoryRedisCommand(["SET", "k", "2", "NX"])).toBeNull();
    expect(memoryRedisCommand(["GET", "k"])).toBe("1");
    expect(memoryRedisCommand(["INCR", "k"])).toBe(2);
    expect(memoryRedisCommand(["DECR", "k"])).toBe(1);
  });

  it("stores hashes, sorted sets and lists", () => {
    memoryRedisCommand(["HSET", "h", "f1", "v1", "f2", "v2"]);
    expect(memoryRedisCommand(["HGET", "h", "f1"])).toBe("v1");
    expect(memoryRedisCommand(["HGETALL", "h"])).toEqual(["f1", "v1", "f2", "v2"]);

    memoryRedisCommand(["ZADD", "z", 10, "a", 20, "b"]);
    expect(memoryRedisCommand(["ZRANGEBYSCORE", "z", "-inf", 15])).toEqual(["a"]);
    expect(memoryRedisCommand(["ZCARD", "z"])).toBe(2);
    expect(memoryRedisCommand(["ZREMRANGEBYSCORE", "z", "-inf", 15])).toBe(1);
    expect(memoryRedisCommand(["ZCARD", "z"])).toBe(1);

    memoryRedisCommand(["RPUSH", "l", "x", "y", "z"]);
    expect(memoryRedisCommand(["LRANGE", "l", 0, -1])).toEqual(["x", "y", "z"]);
    memoryRedisCommand(["LTRIM", "l", 1, -1]);
    expect(memoryRedisCommand(["LRANGE", "l", 0, -1])).toEqual(["y", "z"]);
  });
});

describe("memoryRedisEval", () => {
  beforeEach(() => {
    resetMemoryRedisForTests();
  });

  afterEach(() => {
    resetMemoryRedisForTests();
  });

  it("registers, marks and releases a generation atomically", () => {
    const keys = ["generation:active:s1", "generation:cancel:s1"];
    expect(
      memoryRedisEval({
        script: REGISTER_ACTIVE_SCRIPT,
        keys,
        args: ["token", 360, 600],
      }),
    ).toBe(1);
    expect(
      memoryRedisEval({
        script: REGISTER_ACTIVE_SCRIPT,
        keys,
        args: ["token", 360, 600],
      }),
    ).toBe(0);

    expect(
      memoryRedisEval({
        script: MARK_CANCELLED_SCRIPT,
        keys,
        args: ["wrong", 600, 60],
      }),
    ).toBe(0);
    expect(
      memoryRedisEval({
        script: MARK_CANCELLED_SCRIPT,
        keys,
        args: ["token", 600, 60],
      }),
    ).toBe(1);
    expect(memoryRedisCommand(["GET", "generation:cancel:s1"])).toBe("1");
  });

  it("enforces the rate-limit script across calls", () => {
    const keys = ["ratelimit:v2:generate:1.2.3.4:0"];
    for (let i = 0; i < 3; i += 1) {
      expect(
        memoryRedisEval({ script: RATE_LIMIT_SCRIPT, keys, args: [3, 3600] }),
      ).toEqual([1, 3600]);
    }
    const [allowed, ttl] = memoryRedisEval({
      script: RATE_LIMIT_SCRIPT,
      keys,
      args: [3, 3600],
    }) as [number, number];
    expect(allowed).toBe(0);
    expect(ttl).toBe(3600);
  });

  it("deduplicates sponsor claims and applies ceilings", () => {
    const campaignKey = "sponsor:v1:click-campaign:c1:0";
    const windowKey = "sponsor:v1:click:c1:home:net:0";
    const args = [1800, 5, 3600];

    const claim = (extraKeys: string[] = [], extraArgs: number[] = []) =>
      memoryRedisEval({
        script: CLAIM_SCRIPT,
        keys: [windowKey, campaignKey, ...extraKeys],
        args: [...args, ...extraArgs],
      });

    expect(claim()).toBe(1);
    expect(claim()).toBe(0);
    expect(memoryRedisCommand(["GET", windowKey])).toBe("1");
    expect(memoryRedisCommand(["GET", campaignKey])).toBe("1");
  });

  it("uses string.find/string.sub and only keeps newer pending entries", () => {
    const key = "pending:v1:public-browse-index";
    memoryRedisEval({
      script: UPSERT_PENDING_SCRIPT,
      keys: [key],
      args: ["acme/demo", "0000000000001:1", "0000000000001:1|{\"repo\":\"demo\"}"],
    });
    const older = memoryRedisEval({
      script: UPSERT_PENDING_SCRIPT,
      keys: [key],
      args: ["acme/demo", "0000000000000:1", "0000000000000:1|{\"repo\":\"demo\"}"],
    });
    expect(older).toBe(0);
    expect(memoryRedisCommand(["HGET", key, "acme/demo"])).toBe(
      "0000000000001:1|{\"repo\":\"demo\"}",
    );
  });

  it("spreads unpack into HSET and HDEL in the controls script", () => {
    memoryRedisEval({
      script: WRITE_CONTROLS_SCRIPT,
      keys: ["admin:v1:controls"],
      args: [4, "videoDailyLimit", "40", "videosPaused", "1", "videoPersonDailyLimit"],
    });
    expect(memoryRedisCommand(["HGET", "admin:v1:controls", "videoDailyLimit"])).toBe("40");
    expect(memoryRedisCommand(["HGET", "admin:v1:controls", "videosPaused"])).toBe("1");
    expect(memoryRedisCommand(["HGET", "admin:v1:controls", "videoPersonDailyLimit"])).toBeNull();
    memoryRedisEval({
      script: WRITE_CONTROLS_SCRIPT,
      keys: ["admin:v1:controls"],
      args: [0, "videoDailyLimit"],
    });
    expect(memoryRedisCommand(["HGET", "admin:v1:controls", "videoDailyLimit"])).toBeNull();
  });

  it("releases a distributed lock only for its owner token", () => {
    const keys = ["lock:test"];
    memoryRedisCommand(["SET", "lock:test", "owner", "PX", 1000]);
    expect(
      memoryRedisEval({ script: RELEASE_LOCK_SCRIPT, keys, args: ["other"] }),
    ).toBe(0);
    expect(
      memoryRedisEval({ script: RELEASE_LOCK_SCRIPT, keys, args: ["owner"] }),
    ).toBe(1);
    expect(memoryRedisCommand(["GET", "lock:test"])).toBeNull();
  });

  it("iterates KEYS with ipairs and decrements counters", () => {
    memoryRedisCommand(["SET", "a", "2"]);
    memoryRedisCommand(["SET", "b", "0"]);
    memoryRedisEval({ script: REFUND_SCRIPT, keys: ["a", "b"], args: [] });
    expect(memoryRedisCommand(["GET", "a"])).toBe("1");
    expect(memoryRedisCommand(["GET", "b"])).toBe("0");
  });
});
