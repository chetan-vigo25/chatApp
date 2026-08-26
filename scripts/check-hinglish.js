#!/usr/bin/env node
/**
 * Health check + coverage report for the Hinglish phrase pack.
 *
 *   node scripts/check-hinglish.js                      # integrity only
 *   node scripts/check-hinglish.js messages.txt         # + coverage
 *   node scripts/check-hinglish.js messages.txt -v      # + list the misses
 *
 * Two failures this catches, both of which are invisible by reading the file:
 *
 *  1. DEAD ENTRIES. Lookup normalises the message first ("kr"→"kar",
 *     "thik"→"theek"), so a key written in non-canonical spelling can never be
 *     matched. `'thik hai bye'` sat in the pack doing nothing until this check
 *     found it.
 *
 *  2. DUPLICATES. A repeated key silently overwrites the earlier one.
 *
 * Then point it at a file of real messages (one per line, pulled from your own
 * chat logs) to see the hit rate. That number is what tells you whether adding
 * phrases is working — guessing does not.
 *
 * Exits non-zero when integrity fails, so it can gate a commit.
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const babel = require(path.join(ROOT, 'node_modules/@babel/core'));
const PACK = path.join(ROOT, 'src/constant/hinglish.js');

const source = fs.readFileSync(PACK, 'utf8');
const compiled = babel.transformFileSync(PACK, {
  presets: [require.resolve(path.join(ROOT, 'node_modules/babel-preset-expo'))],
  plugins: [require.resolve(path.join(ROOT, 'node_modules/@babel/plugin-transform-modules-commonjs'))],
  configFile: false,
  babelrc: false,
}).code;
const mod = new Module(PACK);
mod.filename = PACK;
mod._compile(compiled, PACK);
const { hinglishToEnglish, normalizeHinglish, HINGLISH_PHRASE_COUNT } = mod.exports;

// Read the keys from SOURCE, not the object — the object has already lost any
// duplicate, which is exactly what we are looking for.
const block = source.slice(source.indexOf('const PHRASES = {'));
const keys = [...block.matchAll(/^ {2}'([^']+)':/gm)].map((m) => m[1]);

let failed = false;

const seen = new Set();
const duplicates = [];
for (const k of keys) {
  if (seen.has(k)) duplicates.push(k);
  seen.add(k);
}

const dead = keys
  .map((k) => ({ k, n: normalizeHinglish(k) }))
  .filter(({ k, n }) => n !== k);

console.log(`pack: ${HINGLISH_PHRASE_COUNT} phrases\n`);

if (duplicates.length) {
  failed = true;
  console.log(`DUPLICATE KEYS (${duplicates.length}) — the later one silently wins:`);
  duplicates.forEach((k) => console.log(`   '${k}'`));
  console.log('');
}

if (dead.length) {
  failed = true;
  console.log(`DEAD KEYS (${dead.length}) — not canonical, so they can never match:`);
  dead.forEach(({ k, n }) => console.log(`   '${k}'   → rename to →   '${n}'`));
  console.log('');
}

if (!failed) console.log('integrity: no duplicates, no dead keys\n');

const corpus = process.argv[2];
if (corpus && fs.existsSync(corpus)) {
  const lines = fs.readFileSync(corpus, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const miss = lines.filter((l) => !hinglishToEnglish(l));
  const hits = lines.length - miss.length;
  console.log(`corpus:   ${lines.length} messages`);
  console.log(`HIT RATE: ${hits}/${lines.length}  (${Math.round((hits / lines.length) * 100)}%)`);
  if (miss.length && process.argv.includes('-v')) {
    console.log('\nMISSES — add the frequent ones to PHRASES:');
    miss.forEach((x) => console.log(`   "${x}"   → key to add: "${normalizeHinglish(x)}"`));
  } else if (miss.length) {
    console.log(`\n(${miss.length} misses — re-run with -v to list them)`);
  }
}

process.exit(failed ? 1 : 0);
