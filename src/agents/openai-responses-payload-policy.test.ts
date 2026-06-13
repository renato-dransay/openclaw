import { createHash } from "node:crypto";
import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  applyOpenAIResponsesPayloadPolicy,
  normalizePromptCacheKeyLength,
  resolveOpenAIResponsesPayloadPolicy,
} from "./openai-responses-payload-policy.js";

describe("openai responses payload policy", () => {
  it("forces store for native OpenAI responses payloads but keeps disable mode for transport defaults", () => {
    const model = {
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    } satisfies Model<"openai-responses">;

    const providerPolicy = resolveOpenAIResponsesPayloadPolicy(model, {
      storeMode: "provider-policy",
    });
    expect(providerPolicy.explicitStore).toBe(true);
    expect(providerPolicy.allowsServiceTier).toBe(true);

    const disablePolicy = resolveOpenAIResponsesPayloadPolicy(model, { storeMode: "disable" });
    expect(disablePolicy.explicitStore).toBe(false);
    expect(disablePolicy.allowsServiceTier).toBe(true);
  });

  it("couples native Responses server compaction to provider-managed store", () => {
    const model = {
      id: "gpt-5.4",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 200_000,
    } satisfies Pick<
      Model<"openai-responses">,
      "api" | "baseUrl" | "contextWindow" | "id" | "provider"
    >;
    const payload = {} satisfies Record<string, unknown>;

    applyOpenAIResponsesPayloadPolicy(
      payload,
      resolveOpenAIResponsesPayloadPolicy(model, {
        enableServerCompaction: true,
        storeMode: "provider-policy",
      }),
    );

    expect(payload).toEqual({
      store: true,
      context_management: [{ type: "compaction", compact_threshold: 140_000 }],
    });
  });

  it("does not coerce partial context windows for compaction thresholds", () => {
    const model = {
      id: "gpt-5.4",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: "200000tokens",
    } satisfies {
      api: unknown;
      baseUrl: unknown;
      contextWindow: unknown;
      id: unknown;
      provider: unknown;
    };
    const payload = {} satisfies Record<string, unknown>;

    applyOpenAIResponsesPayloadPolicy(
      payload,
      resolveOpenAIResponsesPayloadPolicy(model, {
        enableServerCompaction: true,
        storeMode: "provider-policy",
      }),
    );

    expect(payload).toEqual({
      store: true,
      context_management: [{ type: "compaction", compact_threshold: 80_000 }],
    });
  });

  it("accepts plus-signed responses compaction thresholds", () => {
    const payload = {} satisfies Record<string, unknown>;

    applyOpenAIResponsesPayloadPolicy(
      payload,
      resolveOpenAIResponsesPayloadPolicy(
        {
          api: "openai-responses",
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
        },
        {
          enableServerCompaction: true,
          extraParams: { responsesCompactThreshold: "+120000" },
          storeMode: "provider-policy",
        },
      ),
    );

    expect(payload).toEqual({
      store: true,
      context_management: [{ type: "compaction", compact_threshold: 120_000 }],
    });
  });

  it("strips store and prompt cache for proxy-like responses routes when requested", () => {
    const policy = resolveOpenAIResponsesPayloadPolicy(
      {
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://proxy.example.com/v1",
        compat: { supportsStore: false },
      },
      {
        enablePromptCacheStripping: true,
        storeMode: "provider-policy",
      },
    );
    const payload = {
      store: false,
      prompt_cache_key: "session-123",
      prompt_cache_retention: "24h",
    } satisfies Record<string, unknown>;

    applyOpenAIResponsesPayloadPolicy(payload, policy);

    expect(payload).not.toHaveProperty("store");
    expect(payload).not.toHaveProperty("prompt_cache_key");
    expect(payload).not.toHaveProperty("prompt_cache_retention");
  });

  it("keeps disabled reasoning payloads on native OpenAI responses models that support none", () => {
    const payload = {
      reasoning: {
        effort: "none",
      },
    } satisfies Record<string, unknown>;

    applyOpenAIResponsesPayloadPolicy(
      payload,
      resolveOpenAIResponsesPayloadPolicy(
        {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
          baseUrl: "https://api.openai.com/v1",
        },
        { storeMode: "disable" },
      ),
    );

    expect(payload).toEqual({
      reasoning: {
        effort: "none",
      },
      store: false,
    });
  });

  it("strips disabled reasoning payloads on native OpenAI responses models that do not support none", () => {
    const payload = {
      reasoning: {
        effort: "none",
      },
    } satisfies Record<string, unknown>;

    applyOpenAIResponsesPayloadPolicy(
      payload,
      resolveOpenAIResponsesPayloadPolicy(
        {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5",
          baseUrl: "https://api.openai.com/v1",
        },
        { storeMode: "disable" },
      ),
    );

    expect(payload).toEqual({
      store: false,
    });
  });

  it("strips disabled reasoning payloads for proxy-like OpenAI responses routes", () => {
    const payload = {
      reasoning: {
        effort: "none",
      },
    } satisfies Record<string, unknown>;

    applyOpenAIResponsesPayloadPolicy(
      payload,
      resolveOpenAIResponsesPayloadPolicy(
        {
          api: "openai-responses",
          provider: "openai",
          baseUrl: "https://proxy.example.com/v1",
        },
        { storeMode: "disable" },
      ),
    );

    expect(payload).not.toHaveProperty("reasoning");
  });

  it("emits store false for native OpenAI Codex responses disable mode", () => {
    const policy = resolveOpenAIResponsesPayloadPolicy(
      {
        api: "openai-chatgpt-responses",
        provider: "openai",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
      { storeMode: "disable" },
    );

    expect(policy.explicitStore).toBe(false);
    expect(policy.allowsServiceTier).toBe(true);
    expect(policy.shouldStripStore).toBe(false);
  });

  it("emits store false for aliased native OpenAI Codex responses disable mode", () => {
    const policy = resolveOpenAIResponsesPayloadPolicy(
      {
        api: "openclaw-openai-responses-transport",
        provider: "openai",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
      { storeMode: "disable" },
    );

    expect(policy.explicitStore).toBe(false);
    expect(policy.allowsServiceTier).toBe(true);
    expect(policy.shouldStripStore).toBe(false);
  });

  it("hashes prompt_cache_key when longer than 64 chars during policy application", () => {
    const longKey =
      "agent:roxy:explicit:wf-d4c54502-c54c-4d82-a648-f88b181d7910-escalation_analyze-member-standups_story_11";
    expect(longKey.length).toBeGreaterThan(64);
    const payload: Record<string, unknown> = { prompt_cache_key: longKey };

    applyOpenAIResponsesPayloadPolicy(
      payload,
      resolveOpenAIResponsesPayloadPolicy(
        {
          api: "openai-codex-responses",
          provider: "openai-codex",
          baseUrl: "https://chatgpt.com/backend-api/codex",
        },
        { storeMode: "disable" },
      ),
    );

    expect(payload.prompt_cache_key).toBe(createHash("sha256").update(longKey).digest("hex"));
    expect((payload.prompt_cache_key as string).length).toBe(64);
  });

  it("normalizePromptCacheKeyLength leaves short keys untouched", () => {
    const payload: Record<string, unknown> = { prompt_cache_key: "short-session-id" };
    normalizePromptCacheKeyLength(payload);
    expect(payload.prompt_cache_key).toBe("short-session-id");
  });

  it("normalizePromptCacheKeyLength is a no-op when payload has no cache key", () => {
    const payload: Record<string, unknown> = { foo: "bar" };
    normalizePromptCacheKeyLength(payload);
    expect(payload).toEqual({ foo: "bar" });
  });
});
