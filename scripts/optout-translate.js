#!/usr/bin/env node
/**
 * Reverse of optin-translate.js — take a screen's UI back to plain react-native.
 *
 *   node scripts/optout-translate.js src/screens/profiles/Setting.jsx [...]
 *
 * Moves `Text` / `TextInput` off components/Translate and back onto
 * react-native, so nothing on the screen re-renders when the app language
 * changes. Other imports from the wrapper (useLanguage, needsSystemFont) are
 * LEFT ALONE — a screen can still read the language without translating itself.
 *
 * Also strips the `ignore` props, which only mean something to the wrapper and
 * would otherwise be passed down to react-native's Text as an unknown prop.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let changed = 0;

for (const arg of process.argv.slice(2)) {
  const file = path.resolve(ROOT, arg);
  if (!fs.existsSync(file)) { console.log(`  MISSING  ${arg}`); continue; }
  let code = fs.readFileSync(file, 'utf8');
  const before = code;

  const trImport = code.match(
    /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]*components\/Translate)['"];?/,
  );
  if (!trImport) { console.log(`  SKIP     ${arg}  (no Translate import)`); continue; }

  const trNames = trImport[1].split(',').map((n) => n.trim()).filter(Boolean);
  const moving = trNames.filter((n) => n === 'Text' || n === 'TextInput');
  if (moving.length === 0) { console.log(`  SKIP     ${arg}  (Text already off the wrapper)`); continue; }

  const keepingOnWrapper = trNames.filter((n) => !moving.includes(n));
  const rebuiltTr = keepingOnWrapper.length
    ? `import { ${keepingOnWrapper.join(', ')} } from '${trImport[2]}';`
    : '';
  code = code.slice(0, trImport.index)
    + rebuiltTr
    + code.slice(trImport.index + trImport[0].length);
  // Leave no blank line where the import used to be.
  if (!rebuiltTr) code = code.replace(/\n\n\n+/, '\n\n');

  // Put Text/TextInput back on the react-native import.
  const rn = code.match(/import\s*\{([^}]*)\}\s*from\s*['"]react-native['"];?/);
  if (rn) {
    const names = rn[1].split(',').map((n) => n.trim()).filter(Boolean);
    const merged = [...new Set([...names, ...moving])];
    code = code.slice(0, rn.index)
      + `import {\n  ${merged.join(',\n  ')},\n} from 'react-native';`
      + code.slice(rn.index + rn[0].length);
  } else {
    code = `import { ${moving.join(', ')} } from 'react-native';\n` + code;
  }

  // `ignore` is a wrapper-only prop; react-native's Text should not receive it.
  code = code
    .replace(/<Text\s+ignore\s+/g, '<Text ')
    .replace(/<Text\s+ignore>/g, '<Text>')
    .replace(/<TextInput\s+ignore\s+/g, '<TextInput ')
    .replace(/^\s*ignore=\{[^}]*\}\n/gm, '');

  if (code === before) { console.log(`  NOCHANGE ${arg}`); continue; }
  fs.writeFileSync(file, code);
  console.log(`  OPTED OUT ${arg}  (moved back: ${moving.join(', ')}${keepingOnWrapper.length ? `; kept on wrapper: ${keepingOnWrapper.join(', ')}` : ''})`);
  changed++;
}

console.log(`\n${changed} screen(s) reverted to plain react-native Text.`);
