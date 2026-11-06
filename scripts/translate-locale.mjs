#!/usr/bin/env node
// Fills src/locales/<target>/ from the English catalogs with a PLaMo translation server.
// Usage: node scripts/translate-locale.mjs --url http://host:8890/v1 [--target ja] [--only <namespace>] [--all] [--concurrency 4]
// Without --all only keys missing from the target catalog are translated, so a rerun after an
// upstream update translates the new English keys and keeps reviewed translations.
// Only prose is translated: labels, names, units and short phrases stay in English (see isProse).
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { interpolationParameters } from "./i18n-check.mjs";

const LANGUAGE_NAMES = { ja: "Japanese" };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localesDir = path.join(root, "src", "locales");

function parseArgs(argv) {
  const args = { target: "ja", all: false, concurrency: 4, url: process.env.PLAMO_URL, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") args.all = true;
    else if (a === "--url") args.url = argv[++i];
    else if (a === "--target") args.target = argv[++i];
    else if (a === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (a === "--only") args.only = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!args.url) throw new Error("--url (or PLAMO_URL) is required");
  if (!LANGUAGE_NAMES[args.target]) throw new Error(`no PLaMo language name for ${args.target}`);
  return args;
}

function flatten(catalog, prefix = "", out = new Map()) {
  for (const [key, value] of Object.entries(catalog)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(full, value);
    else flatten(value, full, out);
  }
  return out;
}

/** Rebuilds the English nesting and key order with target strings. */
function rebuild(catalog, flat, prefix = "") {
  const out = {};
  for (const [key, value] of Object.entries(catalog)) {
    const full = prefix ? `${prefix}.${key}` : key;
    out[key] = typeof value === "string" ? flat.get(full) : rebuild(value, flat, full);
  }
  return out;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const CHUNK_LINES = 40;
/** Keys split around inline <code>; the parts of one sentence are judged together so they share a language. */
const FRAGMENT = /(Before|After|Between)$/;

const words = (text) => text.replace(/{{\s*[\w.]+\s*}}/g, "").match(/[A-Za-z][A-Za-z'’-]*/g) ?? [];

/** A sentence or explanation, as opposed to a label: eight words, or four ending in sentence punctuation. */
function isProse(text) {
  const count = words(text).length;
  return count >= 8 || (count >= 4 && /[.?!]$/.test(text.trim()));
}

function proseKeys(flat) {
  const groups = new Map();
  for (const key of flat.keys()) {
    const stem = key.replace(FRAGMENT, "");
    if (stem !== key) groups.set(stem, [...(groups.get(stem) ?? []), key]);
  }
  const prose = new Set();
  for (const [key, text] of flat) {
    const stem = key.replace(FRAGMENT, "");
    const sentence = stem === key ? text : groups.get(stem).map((k) => flat.get(k)).join(" ");
    if (isProse(sentence)) prose.add(key);
  }
  return prose;
}
const CHUNK_CHARS = 3000;

async function plamo(url, text, language, temperature) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await plamoOnce(url, text, language, temperature);
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

async function plamoOnce(url, text, language, temperature) {
  const prompt = `<|plamo:op|>dataset\ntranslation\n<|plamo:op|>input lang=English\n${text}\n<|plamo:op|>output lang=${language}\n`;
  const res = await fetch(`${url.replace(/\/$/, "")}/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "plamo-3-translate", prompt, max_tokens: 6000, temperature, stop: ["<|plamo:op|>"] }),
  });
  if (!res.ok) throw new Error(`PLaMo ${res.status}: ${await res.text()}`);
  return (await res.json()).choices[0].text.trim();
}

const sameParams = (source, out) =>
  JSON.stringify(interpolationParameters(source)) === JSON.stringify(interpolationParameters(out));

/** One string per line keeps PLaMo's context across neighbouring keys, so terms and register stay consistent. */
function toEntry([key, source]) {
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(source);
  return { key, source, lead, core, trail };
}

function chunk(entries) {
  const chunks = [];
  let current = [];
  let chars = 0;
  for (const entry of entries) {
    if (current.length && (current.length >= CHUNK_LINES || chars + entry.core.length > CHUNK_CHARS)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(entry);
    chars += entry.core.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function translateAlone(url, entry, language) {
  for (const temperature of [0, 0.3, 0.6]) {
    const out = await plamo(url, entry.core, language, temperature);
    if (out && !out.includes("\n") && sameParams(entry.source, out)) return out;
  }
  return null;
}

/** Returns [key, text, note?] per entry; lines a batch loses or mangles are retried alone. */
async function translateChunk(url, entries, language) {
  const lines = (await plamo(url, entries.map((e) => e.core).join("\n"), language, 0)).split("\n");
  const aligned = lines.length === entries.length;
  const results = [];
  for (const [i, entry] of entries.entries()) {
    let out = aligned && lines[i].trim() && sameParams(entry.source, lines[i]) ? lines[i].trim() : null;
    out ??= await translateAlone(url, entry, language);
    results.push(out == null
      ? [entry.key, entry.source, "kept English: placeholders or line breaks did not survive"]
      : [entry.key, `${entry.lead}${out}${entry.trail}`]);
  }
  return results;
}

async function pool(items, size, work) {
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

const args = parseArgs(process.argv.slice(2));
const language = LANGUAGE_NAMES[args.target];
const targetDir = path.join(localesDir, args.target);
await mkdir(targetDir, { recursive: true });
const notes = [];

for (const file of (await readdir(path.join(localesDir, "en"))).filter((f) => f.endsWith(".json") && (!args.only || f === `${args.only}.json`)).sort()) {
  const en = JSON.parse(await readFile(path.join(localesDir, "en", file), "utf8"));
  const zh = flatten((await readJson(path.join(localesDir, "zh-CN", file))) ?? {});
  const existing = args.all ? new Map() : flatten((await readJson(path.join(targetDir, file))) ?? {});
  const sources = flatten(en);
  const prose = proseKeys(sources);
  const flat = new Map();
  const todo = [];
  for (const [key, source] of sources) {
    if (existing.has(key)) flat.set(key, existing.get(key));
    // The Chinese catalog keeps names, units and symbols verbatim, even inside long strings.
    else if (!prose.has(key) || zh.get(key) === source) flat.set(key, source);
    else todo.push(toEntry([key, source]));
  }
  await pool(chunk(todo), args.concurrency, async (entries) => {
    for (const [key, text, note] of await translateChunk(args.url, entries, language)) {
      flat.set(key, text);
      if (note) notes.push(`${file} ${key}: ${note}`);
    }
  });
  await writeFile(path.join(targetDir, file), `${JSON.stringify(rebuild(en, flat), null, 2)}\n`);
  console.log(`${file}: ${todo.length} translated, ${flat.size - todo.length} kept`);
}
for (const note of notes) console.log(note);
