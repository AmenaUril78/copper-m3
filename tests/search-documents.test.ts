// @vitest-environment node
// Module 3: Ask Copper searching the customer PDFs. The model is mocked, so
// these need no AI key and cost nothing; the PDFs are small ones made here, so
// they don't depend on the real documents being in public/docs/.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callEmbed } from "@/lib/ai/call";
import {
  cosineSimilarity,
  passagesOf,
  rankPassages,
  resetDocumentIndex,
  searchDocuments,
  splitPage,
} from "@/lib/copper/assistant/search-documents";
import { DOCUMENTS } from "@/lib/copper/documents";
import { tempDir } from "./helpers/temp-dir";

vi.mock("@/lib/ai/call", () => ({ callEmbed: vi.fn() }));

// A stand-in for the embedding model: each text becomes counts of a few words,
// so passages about the same thing end up pointing the same way.
const WORDS = ["return", "setup", "plus", "privacy"];
const vectorOf = (text: string) =>
  WORDS.map((word) => text.toLowerCase().split(word).length - 1);

/** Builds a small, valid PDF with one line of text per page. */
function pdfWith(pages: string[]): Buffer {
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pages
    .map((_, i) => `${4 + 2 * i} 0 R`)
    .join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects[4 + 2 * i] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + 2 * i} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    objects[5 + 2 * i] =
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  out += offsets
    .slice(1)
    .map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)
    .join("");
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

/** Puts a fake public/docs/ with all four PDFs in a temp folder. */
function installPdfs() {
  const root = tempDir("copper-docs-");
  mkdirSync(join(root, "public", "docs"), { recursive: true });
  for (const doc of DOCUMENTS) {
    const pages =
      doc.kind === "Terms"
        ? [
            "Welcome to the Copper State Labs terms.",
            "Return policy: you may return a device within 30 days for a full refund.",
          ]
        : [`Setup steps for the ${doc.title}. Plus members get extras.`];
    writeFileSync(join(root, "public", doc.file), pdfWith(pages));
  }
  vi.spyOn(process, "cwd").mockReturnValue(root);
  return root;
}

const embed = vi.mocked(callEmbed);

beforeEach(() => {
  resetDocumentIndex();
  embed.mockReset();
  embed.mockImplementation((async (
    _info: unknown,
    { values }: { values: string[] },
  ) => ({
    embeddings: values.map(vectorOf),
  })) as unknown as typeof callEmbed);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("splitPage", () => {
  it("keeps a short page as one passage and drops an empty page", () => {
    expect(splitPage("  Hello   world  ")).toEqual(["Hello world"]);
    expect(splitPage("   \n  ")).toEqual([]);
  });

  it("cuts a long page into passages of at most 1500 characters, between paragraphs", () => {
    const paragraph = "word ".repeat(200).trim(); // 999 characters
    const pieces = splitPage(`${paragraph}\n\n${paragraph}\n\n${paragraph}`);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(1500);
  });
});

describe("passagesOf, cosineSimilarity and rankPassages", () => {
  const doc = DOCUMENTS[2];

  it("numbers pages from 1 and remembers which document each passage is from", () => {
    const passages = passagesOf(doc, ["first page", "", "third page"]);
    expect(passages.map((p) => p.page)).toEqual([1, 3]);
    expect(passages[0]).toMatchObject({
      documentId: doc.id,
      title: doc.title,
      kind: doc.kind,
    });
  });

  it("scores matching directions as 1, unrelated ones as 0, and empty ones as 0", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 9);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("returns the closest passages first, and at most four", () => {
    const passages = passagesOf(doc, ["a", "b", "c", "d", "e", "f"]);
    const embeddings = [
      [0, 1],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 1],
      [0, 1],
    ];
    const found = rankPassages([1, 0], passages, embeddings);
    expect(found).toHaveLength(4);
    expect(found.map((p) => p.page).slice(0, 2)).toEqual([2, 3]);
    expect(found[0].score).toBeGreaterThan(found[1].score);
  });
});

describe("searchDocuments", () => {
  it("reads the PDFs and finds the passage about returns, with its document and page", async () => {
    installPdfs();
    const result = await searchDocuments("What's your return policy?");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.passages[0]).toMatchObject({
      document: "Copper State Labs Terms and Conditions",
      kind: "Terms",
      page: 2,
    });
    expect(result.passages[0].text).toMatch(/30 days/);
    expect(result.passages.length).toBeLessThanOrEqual(4);
  });

  it("reads and embeds the PDFs once, then only embeds each new question", async () => {
    installPdfs();
    await searchDocuments("return policy");
    await searchDocuments("how do I set up plus?");
    // One call to index the passages, plus one per question.
    expect(embed).toHaveBeenCalledTimes(3);
    expect(embed.mock.calls[0][0]).toMatchObject({ module: 3 });
    expect(embed.mock.calls[0][1].values.length).toBe(5);
    expect(embed.mock.calls[1][1].values).toEqual(["return policy"]);
  });

  it("says the documents aren't available when the PDFs aren't there, and finds them once they are", async () => {
    const root = tempDir("copper-empty-");
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const none = await searchDocuments("return policy");
    expect(none.status).toBe("no_documents");
    expect(embed).not.toHaveBeenCalled();

    installPdfs();
    const found = await searchDocuments("return policy");
    expect(found.status).toBe("ok");
  });

  it("says it can't search, instead of crashing, when the model call fails, and tries again next time", async () => {
    installPdfs();
    embed.mockRejectedValueOnce(new Error("quota"));
    const failed = await searchDocuments("return policy");
    expect(failed).toMatchObject({ status: "unavailable" });
    const retried = await searchDocuments("return policy");
    expect(retried.status).toBe("ok");
  });
});

describe("the search_documents tool", () => {
  it("is one of Copper's tools, described for the model, and runs the search", async () => {
    installPdfs();
    const { copperTools } = await import("@/lib/copper/assistant/tools");
    const tool = copperTools.search_documents;
    expect(tool.description).toMatch(/documents/i);
    const output = await tool.execute!(
      { question: "return policy" },
      { toolCallId: "t1", messages: [], context: {} },
    );
    expect(output).toMatchObject({ status: "ok" });
  });

  it("is labelled for the chat panel and mentioned in Copper's instructions", async () => {
    const { TOOL_LABELS } = await import("@/lib/copper/assistant/progress");
    const { COPPER_INSTRUCTIONS } =
      await import("@/lib/copper/assistant/instructions");
    expect(TOOL_LABELS.search_documents).toBeTruthy();
    expect(COPPER_INSTRUCTIONS).toContain("search_documents");
    expect(COPPER_INSTRUCTIONS).toMatch(/page/i);
  });
});
