#!/usr/bin/env node
/**
 * Opt a screen into app-language translation.
 *
 *   node scripts/optin-translate.js src/screens/profiles/Privacy.jsx [...]
 *
 * Does only the mechanical half: moves `Text` (and `TextInput`) off react-native
 * and onto components/Translate. It does NOT decide which strings are user data
 * — run scripts/check-translate-optin.js afterwards and add `ignore` where it
 * points, then read the diff yourself.
 *
 * Idempotent: running it twice changes nothing.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WRAPPER = path.join(ROOT, 'src/components/Translate');

function relativeWrapper(file) {
  let rel = path.relative(path.dirname(file), WRAPPER);
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel.split(path.sep).join('/');
}

let changed = 0;
let skipped = 0;

for (const arg of process.argv.slice(2)) {
  const file = path.resolve(ROOT, arg);
  if (!fs.existsSync(file)) { console.log(`  MISSING  ${arg}`); continue; }

  let code = fs.readFileSync(file, 'utf8');
  const wrapper = relativeWrapper(file);

  const rnImport = code.match(/import\s*\{([^}]*)\}\s*from\s*['"]react-native['"];?/);
  if (!rnImport) { console.log(`  SKIP     ${arg}  (no react-native named import)`); skipped++; continue; }

  const names = rnImport[1].split(',').map((n) => n.trim()).filter(Boolean);
  const moving = names.filter((n) => n === 'Text' || n === 'TextInput');
  if (moving.length === 0) { console.log(`  SKIP     ${arg}  (imports no Text/TextInput)`); skipped++; continue; }

  const keeping = names.filter((n) => !moving.includes(n));
  const rebuiltRn = keeping.length
    ? `import {\n  ${keeping.join(',\n  ')},\n} from 'react-native';`
    : '';
  code = code.slice(0, rnImport.index) + rebuiltRn + code.slice(rnImport.index + rnImport[0].length);

  // Merge into an existing Translate import rather than adding a second one.
  const existing = code.match(
    new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"][^'"]*components/Translate['"];?`),
  );
  if (existing) {
    const have = existing[1].split(',').map((n) => n.trim()).filter(Boolean);
    const merged = [...new Set([...moving, ...have])];
    code = code.slice(0, existing.index)
      + `import { ${merged.join(', ')} } from '${wrapper}';`
      + code.slice(existing.index + existing[0].length);
  } else {
    const anchor = rebuiltRn ? rebuiltRn : '';
    const insertAt = anchor ? code.indexOf(anchor) + anchor.length : 0;
    code = code.slice(0, insertAt)
      + `\nimport { ${moving.join(', ')} } from '${wrapper}';`
      + code.slice(insertAt);
  }

  fs.writeFileSync(file, code);
  console.log(`  OPTED IN ${arg}  (moved: ${moving.join(', ')})`);
  changed++;
}

console.log(`\n${changed} opted in, ${skipped} skipped.`);
console.log('Now run: node scripts/check-translate-optin.js');
