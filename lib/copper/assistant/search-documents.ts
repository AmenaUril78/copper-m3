// Module 3: searching Copper State Labs' customer documents (the PDFs in
// public/docs/). This is "retrieval": the PDFs are cut into page-sized
// passages, each passage is turned into an embedding (a list of numbers that
// captures its meaning), and a question is matched to the passages whose
// numbers are closest. Copper then answers from those passages and says which
// document and page they came from.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { callEmbed } from "@/lib/ai/call";
import { DOCUMENTS, type CopperDocument } from "@/lib/copper/documents";

export type Passage = {
  documentId: string;
  title: string;
  kind: CopperDocument["kind"];
  /** The page of the PDF, starting at 1. */
  page: number;
  text: string;
};

export type FoundPassage = {
  document: string;
  kind: CopperDocument["kind"];
  page: number;
  text: string;
  /** How close the passage is to the question, from 0 (unrelated) to 1. */
  score: number;
};

export type DocumentSearch =
  | { status: "ok"; passages: FoundPassage[] }
  | { status: "no_documents"; message: string }
  | { status: "unavailable"; message: string };

/** Passages longer than this are cut into pieces, so each one stays focused. */
const MAX_PASSAGE_CHARS = 1500;
/** How many passages come back for a question. */
const TOP_PASSAGES = 4;

/** Tidies the text the PDF reader gives back: one space between words. */
function clean(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Cuts one page of text into passages of at most MAX_PASSAGE_CHARS, breaking
 * between paragraphs where it can. Most pages are a single passage.
 */
export function splitPage(text: string): string[] {
  const page = clean(text);
  if (!page) return [];
  if (page.length <= MAX_PASSAGE_CHARS) return [page];
  const pieces: string[] = [];
  let current = "";
  for (const paragraph of page.split(/\n\s*\n/)) {
    // A single paragraph that is too long is cut by length.
    for (let i = 0; i < paragraph.length; i += MAX_PASSAGE_CHARS) {
      const part = paragraph.slice(i, i + MAX_PASSAGE_CHARS);
      if (current && current.length + part.length + 2 > MAX_PASSAGE_CHARS) {
        pieces.push(current);
        current = part;
      } else {
        current = current ? `${current}\n\n${part}` : part;
      }
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/** Turns each document's pages (page 1 first) into passages. */
export function passagesOf(doc: CopperDocument, pages: string[]): Passage[] {
  return pages.flatMap((text, index) =>
    splitPage(text).map((piece) => ({
      documentId: doc.id,
      title: doc.title,
      kind: doc.kind,
      page: index + 1,
      text: piece,
    })),
  );
}

/** How alike two embeddings are: 1 means the same direction, 0 unrelated. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

/** The `count` passages closest to the question, best first. */
export function rankPassages(
  question: number[],
  passages: Passage[],
  embeddings: number[][],
  count = TOP_PASSAGES,
): FoundPassage[] {
  return passages
    .map((passage, i) => ({
      document: passage.title,
      kind: passage.kind,
      page: passage.page,
      text: passage.text,
      score:
        Math.round(cosineSimilarity(question, embeddings[i]) * 1000) / 1000,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, count);
}

/** Reads one PDF from public/docs/ and returns the text of each page. */
async function readPages(doc: CopperDocument): Promise<string[] | null> {
  try {
    const bytes = await readFile(path.join(process.cwd(), "public", doc.file));
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: false });
    return text;
  } catch {
    // The PDF isn't there (they're added in class) or can't be read.
    return null;
  }
}

type Index = { passages: Passage[]; embeddings: number[][] };

// Reading and embedding the PDFs happens once, the first time somebody asks.
// After that the answer to "where is the passage about returns?" is a quick
// comparison of numbers in memory.
let index: Promise<Index> | null = null;

async function buildIndex(): Promise<Index> {
  const pages = await Promise.all(DOCUMENTS.map(readPages));
  const passages = DOCUMENTS.flatMap((doc, i) =>
    pages[i] ? passagesOf(doc, pages[i]) : [],
  );
  if (passages.length === 0) return { passages, embeddings: [] };
  const { embeddings } = await callEmbed(
    { module: 3, feature: "index-documents" },
    { values: passages.map((p) => p.text) },
  );
  return { passages, embeddings };
}

/** Forgets the saved index, so the next search reads the PDFs again. */
export function resetDocumentIndex() {
  index = null;
}

/** search_documents: the passages of the customer PDFs closest to a question. */
export async function searchDocuments(
  question: string,
): Promise<DocumentSearch> {
  try {
    index ??= buildIndex();
    const { passages, embeddings } = await index;
    if (passages.length === 0) {
      // Don't remember "no PDFs": they may be added while the app is running.
      index = null;
      return {
        status: "no_documents",
        message: "The customer documents aren't available right now.",
      };
    }
    const {
      embeddings: [asked],
    } = await callEmbed(
      { module: 3, feature: "search-documents" },
      { values: [question] },
    );
    return {
      status: "ok",
      passages: rankPassages(asked, passages, embeddings),
    };
  } catch {
    // Try again from scratch next time, in case the failure was temporary.
    index = null;
    return {
      status: "unavailable",
      message:
        "The documents can't be searched right now. Please try again soon.",
    };
  }
}
