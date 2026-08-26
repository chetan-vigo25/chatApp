#!/usr/bin/env node
/**
 * Guard for screens that use the translating <Text>.
 *
 *   node scripts/check-translate-optin.js
 *
 * Swapping a screen's Text import to components/Translate makes EVERY string
 * child get translated. That is the point for labels — and a bug for user
 * data. A contact's name, an email, a phone number or a message body must
 * never be fed through a translator; it is someone's actual data, and the
 * result is mangled and wrong.
 *
 * The fix is one prop: <Text ignore>. This finds the ones that forgot it.
 *
 * When a flagged string really IS a UI label that should translate (a date
 * bucket like "Today", a title passed as a literal prop), mark the line with a
 * `i18n-ok` comment instead — that records the decision so the check stays
 * green and the next reader knows it was looked at, not missed.
 *
 * Exits non-zero when something looks wrong, so it can gate a commit.
 */
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

/**
 * Identifiers that mean "this is a person's data, not a UI label".
 * Deliberately broad — a false alarm costs one `ignore`, a miss ships a bug.
 */
const USER_DATA = /\b(name|fullName|firstName|lastName|username|displayName|email|phone|mobile|number|about|status|bio|message|text|body|caption|title|content|contact|profile|user|sender|author|address|url|link|otp|code|amount|price|id)\b/i;

/** Things that are safe even though they match above (counts, formatted time). */
const SAFE_CALLS = /^(formatTime|formatDate|moment|dayjs|String|Number|t)\b/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full, out); continue; }
    if (/\.(jsx?|tsx?)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Does this file import Text from the translating wrapper? */
function importsTranslatedText(code) {
  return /import\s*\{[^}]*\bText\b[^}]*\}\s*from\s*['"][^'"]*components\/Translate['"]/.test(code);
}

const findings = [];
let scanned = 0;

for (const file of walk(SRC)) {
  const code = fs.readFileSync(file, 'utf8');
  if (!importsTranslatedText(code)) continue;
  scanned += 1;

  const codeLines = code.split('\n');
  let ast;
  try {
    ast = parser.parse(code, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript', 'classProperties', 'optionalChaining', 'nullishCoalescingOperator'],
    });
  } catch (err) {
    findings.push({ file, line: 0, why: `could not parse: ${err.message.split('\n')[0]}` });
    continue;
  }

  traverse(ast, {
    JSXElement(p) {
      const open = p.node.openingElement;
      if (open.name?.type !== 'JSXIdentifier' || open.name.name !== 'Text') return;

      // `ignore` in any form (bare, ={true}, ={someFlag}) counts as handled —
      // a dynamic flag is a deliberate decision by the author.
      const hasIgnore = open.attributes.some(
        (a) => a.type === 'JSXAttribute' && a.name?.name === 'ignore',
      );
      if (hasIgnore) return;

      for (const child of p.node.children) {
        if (child.type !== 'JSXExpressionContainer') continue;
        const src = code.slice(child.start, child.end);
        if (!USER_DATA.test(src)) continue;
        if (SAFE_CALLS.test(src.replace(/^\{\s*/, ''))) continue;
        // An explicit "reviewed, this is a label" marker on or above the line.
        const lineNo = child.loc.start.line;
        // A few lines of slack: the marker often sits above the enclosing
        // prop or JSX line rather than immediately above the expression.
        const near = codeLines.slice(Math.max(0, lineNo - 6), lineNo).join('\n');
        if (/i18n-ok/.test(near)) continue;
        findings.push({
          file: path.relative(ROOT, file),
          line: child.loc.start.line,
          why: `renders user data without \`ignore\`: ${src.replace(/\s+/g, ' ').slice(0, 70)}`,
        });
      }
    },
  });
}

console.log(`scanned ${scanned} screen(s) using the translating <Text>\n`);

if (findings.length === 0) {
  console.log('  no unguarded user data found');
  process.exit(0);
}

for (const f of findings) console.log(`  ${f.file}:${f.line}\n    ${f.why}\n`);
console.log(`${findings.length} place(s) need \`ignore\` — or confirm they really are UI labels.`);
process.exit(1);
