/* parse index.js the way wrangler does, so a broken build never ships */
const acorn = require('acorn');
const src = require('fs').readFileSync('src/index.js', 'utf8');
try {
  acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
  console.log('ok — parses as a module');
} catch (e) {
  const lines = src.split('\n'), ln = e.loc.line;
  console.log('SYNTAX ERROR:', e.message);
  for (let i = Math.max(0, ln - 6); i < Math.min(lines.length, ln + 2); i++)
    console.log(String(i + 1).padStart(5), (i + 1 === ln ? '>> ' : '   ') + lines[i]);
  process.exit(1);
}
