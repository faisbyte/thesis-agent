import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";

/**
 * Extracted text conventions (shared with extract-pdf.ts and chunk.ts):
 *  - blocks (paragraphs, list items, captions...) are separated by a blank line
 *  - headings are their own block, prefixed with "## "
 */
export interface Extracted {
  text: string;
  title: string | null;
}

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "NAV", "BUTTON", "FORM", "SVG", "TEMPLATE", "IFRAME"]);
const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
const BLOCK_TAGS = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "ASIDE",
  "UL", "OL", "LI", "DL", "DT", "DD", "BLOCKQUOTE", "PRE", "FIGURE", "FIGCAPTION",
  "TABLE", "THEAD", "TBODY", "TR", "HR",
]);

/** Convert a DOM subtree to text with paragraph breaks and "## " headings. */
export function htmlToText(root: Element): string {
  const blocks: string[] = [];
  let buf = "";

  const flush = (prefix = "") => {
    const t = buf.replace(/\s+/g, " ").trim();
    if (t) blocks.push(prefix + t);
    buf = "";
  };

  const walk = (node: Node) => {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      buf += (node as Text).data;
      return;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return;
    if (tag === "MATH") {
      // MathML textContent is unreadable; LaTeXML (arxiv) puts the TeX source in alttext.
      buf += ` ${el.getAttribute("alttext") ?? el.textContent ?? ""} `;
      return;
    }
    if (HEADING_TAGS.has(tag)) {
      flush();
      el.childNodes.forEach(walk);
      flush("## ");
      return;
    }
    if (tag === "BR") {
      buf += " ";
      return;
    }
    if (tag === "TD" || tag === "TH") {
      el.childNodes.forEach(walk);
      buf += " ";
      return;
    }
    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) flush();
    el.childNodes.forEach(walk);
    if (isBlock) flush();
  };

  walk(root);
  flush();
  return blocks.join("\n\n");
}

function parse(html: string, url?: string): Document {
  // Silence jsdom's CSS parse errors etc.
  return new JSDOM(html, { url, virtualConsole: new VirtualConsole() }).window.document;
}

/**
 * Generic HTML article extraction: Readability, falling back to the <main>
 * (or <body>) text when Readability keeps under half of it.
 */
export function extractHtml(html: string, url?: string): Extracted {
  const doc = parse(html, url);
  const fallbackRoot = doc.querySelector("main") ?? doc.body;
  const fallbackText = fallbackRoot ? htmlToText(fallbackRoot) : "";

  const article = new Readability(doc.cloneNode(true) as Document).parse();
  let readabilityText = "";
  if (article?.content) {
    const container = doc.createElement("div");
    container.innerHTML = article.content;
    readabilityText = htmlToText(container);
  }

  const text = readabilityText.length >= fallbackText.length / 2 ? readabilityText : fallbackText;
  const title = article?.title?.trim() || doc.title.trim() || null;
  return { text, title };
}

/**
 * arxiv's HTML papers are LaTeXML output with a well-structured
 * <article class="ltx_document">. Extract that directly rather than going
 * through Readability, which tends to drop the abstract and section headings.
 * Returns null when the page isn't a LaTeXML paper.
 */
export function extractArxivHtml(html: string, url?: string): Extracted | null {
  const doc = parse(html, url);
  const article = doc.querySelector("article.ltx_document");
  if (!article) return null;
  // Footnote markers and the "Report issue" widgets add noise.
  article.querySelectorAll(".ltx_note_mark, .ltx_tag_note, .ltx_page_footer, .ltx_role_report").forEach((el) => el.remove());
  const titleEl = article.querySelector(".ltx_title_document");
  return { text: htmlToText(article), title: titleEl?.textContent?.replace(/\s+/g, " ").trim() || null };
}

/** Title and authors from an arxiv /abs/ page's citation_* meta tags. */
export function parseArxivAbsMeta(html: string): { title: string | null; authors: string | null } {
  const doc = parse(html);
  const title = doc.querySelector('meta[name="citation_title"]')?.getAttribute("content")?.trim() || null;
  const authors = [...doc.querySelectorAll('meta[name="citation_author"]')]
    .map((m) => m.getAttribute("content")?.trim())
    .filter(Boolean)
    .join("; ");
  return { title, authors: authors || null };
}
