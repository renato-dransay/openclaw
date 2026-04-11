import { describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import {
  DEFAULT_COMMAND_SPECS,
  parseSlashCommandPayload,
  registerSlashCommands,
  resolveCallbackUrl,
  resolveCommandText,
  resolveSlashCommandConfig,
} from "./slash-commands.js";

describe("slash-commands", () => {
  async function registerSingleStatusCommand(
    requestImpl: (path: string, init?: { method?: string }) => Promise<unknown>,
  ) {
    const client: MattermostClient = {
      baseUrl: "https://chat.example.com",
      apiBaseUrl: "https://chat.example.com/api/v4",
      token: "bot-token",
      request: async <T>(path: string, init?: RequestInit) => (await requestImpl(path, init)) as T,
      fetchImpl: vi.fn<typeof fetch>(),
    };
    return registerSlashCommands({
      client,
      teamId: "team-1",
      creatorUserId: "bot-user",
      callbackUrl: "http://gateway/callback",
      commands: [
        {
          trigger: "oc_status",
          description: "status",
          autoComplete: true,
        },
      ],
    });
  }

  it("parses application/x-www-form-urlencoded payloads", () => {
    const payload = parseSlashCommandPayload(
      "token=t1&team_id=team&channel_id=ch1&user_id=u1&command=%2Foc_status&text=now",
      "application/x-www-form-urlencoded",
    );
    expect(payload).toMatchObject({
      token: "t1",
      team_id: "team",
      channel_id: "ch1",
      user_id: "u1",
      command: "/oc_status",
      text: "now",
    });
  });

  it("parses application/json payloads", () => {
    const payload = parseSlashCommandPayload(
      JSON.stringify({
        token: "t2",
        team_id: "team",
        channel_id: "ch2",
        user_id: "u2",
        command: "/oc_model",
        text: "gpt-5",
      }),
      "application/json; charset=utf-8",
    );
    expect(payload).toMatchObject({
      token: "t2",
      command: "/oc_model",
      text: "gpt-5",
    });
  });

  it("returns null for malformed payloads missing required fields", () => {
    const payload = parseSlashCommandPayload(
      JSON.stringify({ token: "t3", command: "/oc_help" }),
      "application/json",
    );
    expect(payload).toBeNull();
  });

  it("resolves command text with trigger map fallback", () => {
    const triggerMap = new Map<string, string>([["oc_status", "status"]]);
    expect(resolveCommandText("oc_status", "   ", triggerMap)).toBe("/status");
    expect(resolveCommandText("oc_status", " now ", triggerMap)).toBe("/status now");
    expect(resolveCommandText("oc_models", " openai ", undefined)).toBe("/models openai");
    expect(resolveCommandText("oc_help", "", undefined)).toBe("/help");
  });

  it("registers both public model slash commands", () => {
    expect(
      DEFAULT_COMMAND_SPECS.filter(
        (spec) => spec.trigger === "oc_model" || spec.trigger === "oc_models",
      ).map((spec) => spec.trigger),
    ).toEqual(["oc_model", "oc_models"]);
  });

  it("normalizes callback path in slash config", () => {
    const config = resolveSlashCommandConfig({ callbackPath: "api/channels/mattermost/command" });
    expect(config.callbackPath).toBe("/api/channels/mattermost/command");
  });

  it("falls back to localhost callback URL for wildcard bind hosts", () => {
    const config = resolveSlashCommandConfig({ callbackPath: "/api/channels/mattermost/command" });
    const callbackUrl = resolveCallbackUrl({
      config,
      gatewayPort: 18789,
      gatewayHost: "0.0.0.0",
    });
    expect(callbackUrl).toBe("http://localhost:18789/api/channels/mattermost/command");
  });

  it("reuses existing command when trigger already points to callback URL", async () => {
    const request = vi.fn(async (path: string) => {
      if (path.startsWith("/commands?team_id=")) {
        return [
          {
            id: "cmd-1",
            token: "tok-1",
            team_id: "team-1",
            creator_id: "bot-user",
            trigger: "oc_status",
            method: "P",
            url: "http://gateway/callback",
            auto_complete: true,
          },
        ];
      }
      throw new Error(`unexpected request path: ${path}`);
    });
    const result = await registerSingleStatusCommand(request);

    expect(result).toHaveLength(1);
    expect(result[0]?.managed).toBe(false);
    expect(result[0]?.id).toBe("cmd-1");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("recovers from concurrent-create races by reusing the winner", async () => {
    let listCalls = 0;
    const request = vi.fn(async (path: string, init?: { method?: string }) => {
      if (path.startsWith("/commands?team_id=")) {
        listCalls += 1;
        if (listCalls === 1) {
          return [];
        }
        return [
          {
            id: "cmd-winner",
            token: "tok-winner",
            team_id: "team-1",
            creator_id: "other-bot-user",
            trigger: "oc_status",
            method: "P",
            url: "http://gateway/callback",
            auto_complete: true,
          },
        ];
      }
      if (path === "/commands" && init?.method === "POST") {
        throw new Error("Mattermost API 400 : This trigger word is already in use.");
      }
      throw new Error(`unexpected request: ${path} (${init?.method})`);
    });
    const result = await registerSingleStatusCommand(request);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("cmd-winner");
    expect(result[0]?.managed).toBe(false);
    expect(result[0]?.token).toBe("tok-winner");
    expect(listCalls).toBe(2);
  });

  it("treats commands at our callback URL as owned even if creator_id differs", async () => {
    const request = vi.fn(async (path: string) => {
      if (path.startsWith("/commands?team_id=")) {
        return [
          {
            id: "cmd-sibling",
            token: "tok-sibling",
            team_id: "team-1",
            creator_id: "sibling-bot-user",
            trigger: "oc_status",
            method: "P",
            url: "http://gateway/callback",
            auto_complete: true,
          },
        ];
      }
      throw new Error(`unexpected request path: ${path}`);
    });
    const result = await registerSingleStatusCommand(request);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("cmd-sibling");
    expect(result[0]?.managed).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("deletes duplicate owned commands and keeps the oldest", async () => {
    const deleted: string[] = [];
    const request = vi.fn(async (path: string, init?: { method?: string }) => {
      if (path.startsWith("/commands?team_id=")) {
        return [
          {
            id: "cmd-newer",
            token: "tok-newer",
            team_id: "team-1",
            creator_id: "bot-user",
            trigger: "oc_status",
            method: "P",
            url: "http://gateway/callback",
            auto_complete: true,
            create_at: 2000,
          },
          {
            id: "cmd-older",
            token: "tok-older",
            team_id: "team-1",
            creator_id: "bot-user",
            trigger: "oc_status",
            method: "P",
            url: "http://gateway/callback",
            auto_complete: true,
            create_at: 1000,
          },
        ];
      }
      if (init?.method === "DELETE") {
        const match = path.match(/^\/commands\/([^/?]+)/);
        if (match) {
          deleted.push(decodeURIComponent(match[1]));
          return {};
        }
      }
      throw new Error(`unexpected request: ${path} (${init?.method})`);
    });
    const result = await registerSingleStatusCommand(request);

    expect(deleted).toEqual(["cmd-newer"]);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("cmd-older");
    expect(result[0]?.managed).toBe(false);
  });

  it("serializes concurrent registrations against the same team", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let listCalls = 0;
    const created = new Map<string, { id: string; token: string; create_at: number }>();
    let nextId = 1;
    const request = vi.fn(async (path: string, init?: { method?: string }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 5));
        if (path.startsWith("/commands?team_id=")) {
          listCalls += 1;
          return Array.from(created.values()).map((c) => ({
            id: c.id,
            token: c.token,
            team_id: "team-1",
            creator_id: "bot-user",
            trigger: "oc_status",
            method: "P",
            url: "http://gateway/callback",
            auto_complete: true,
            create_at: c.create_at,
          }));
        }
        if (path === "/commands" && init?.method === "POST") {
          if (created.has("oc_status")) {
            throw new Error("Mattermost API 400 : This trigger word is already in use.");
          }
          const id = `cmd-${nextId++}`;
          const entry = { id, token: `tok-${id}`, create_at: Date.now() };
          created.set("oc_status", entry);
          return {
            id,
            token: entry.token,
            team_id: "team-1",
            creator_id: "bot-user",
            trigger: "oc_status",
            method: "P",
            url: "http://gateway/callback",
            auto_complete: true,
            create_at: entry.create_at,
          };
        }
        throw new Error(`unexpected request: ${path} (${init?.method})`);
      } finally {
        inFlight -= 1;
      }
    });

    const results = await Promise.all([
      registerSingleStatusCommand(request),
      registerSingleStatusCommand(request),
      registerSingleStatusCommand(request),
      registerSingleStatusCommand(request),
      registerSingleStatusCommand(request),
    ]);

    expect(maxInFlight).toBe(1);
    expect(created.size).toBe(1);
    const ids = new Set(results.map((r) => r[0]?.id));
    expect(ids.size).toBe(1);
    // First call creates; subsequent calls only need to list.
    expect(listCalls).toBe(5);
  });

  it("skips foreign command trigger collisions instead of mutating non-owned commands", async () => {
    const request = vi.fn(async (path: string, init?: { method?: string }) => {
      if (path.startsWith("/commands?team_id=")) {
        return [
          {
            id: "cmd-foreign-1",
            token: "tok-foreign-1",
            team_id: "team-1",
            creator_id: "another-bot-user",
            trigger: "oc_status",
            method: "P",
            url: "http://foreign/callback",
            auto_complete: true,
          },
        ];
      }
      if (init?.method === "POST" || init?.method === "PUT" || init?.method === "DELETE") {
        throw new Error("should not mutate foreign commands");
      }
      throw new Error(`unexpected request path: ${path}`);
    });
    const result = await registerSingleStatusCommand(request);

    expect(result).toHaveLength(0);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
