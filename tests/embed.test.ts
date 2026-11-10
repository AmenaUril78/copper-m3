// @vitest-environment node
import { MockEmbeddingModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiNotConfiguredError, callEmbed } from "@/lib/ai/call";
import { EMBEDDING_MODEL } from "@/lib/ai/models";

let model: MockEmbeddingModelV4;
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => ({ embedding: () => model }),
}));

/** Captures the rows printed as "[ai_calls] {...}". */
function captureLog() {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  return () =>
    info.mock.calls
      .filter(([tag]) => tag === "[ai_calls]")
      .map(([, row]) => JSON.parse(row as string));
}

beforeEach(() => {
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "AIza-test-key");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("callEmbed", () => {
  it("returns one embedding per text, in order, and logs the call", async () => {
    model = new MockEmbeddingModelV4({
      doEmbed: async ({ values }) => ({
        embeddings: values.map((text) => [text.length, 1]),
        usage: { tokens: values.length * 6 },
        warnings: [],
      }),
    });
    const logged = captureLog();
    const result = await callEmbed(
      { module: 3, feature: "search-documents" },
      { values: ["one", "three"] },
    );
    expect(result.embeddings).toEqual([
      [3, 1],
      [5, 1],
    ]);
    expect(logged()).toHaveLength(1);
    expect(logged()[0]).toMatchObject({
      module: 3,
      feature: "search-documents",
      model: EMBEDDING_MODEL.id,
      input_tokens: 12,
      ok: true,
    });
  });

  it("logs a failed call and passes the error on", async () => {
    model = new MockEmbeddingModelV4({
      doEmbed: async () => {
        throw new Error("boom");
      },
    });
    const logged = captureLog();
    await expect(
      callEmbed({ module: 3, feature: "x" }, { values: ["a"] }),
    ).rejects.toThrow();
    expect(logged()[0]).toMatchObject({ ok: false, input_tokens: null });
  });

  it("asks for setup, without logging, when there is no key", async () => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "");
    const logged = captureLog();
    await expect(
      callEmbed({ module: 3, feature: "x" }, { values: ["a"] }),
    ).rejects.toBeInstanceOf(AiNotConfiguredError);
    expect(logged()).toHaveLength(0);
  });
});
