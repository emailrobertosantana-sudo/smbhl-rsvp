const fs = require('fs');
const content = fs.readFileSync('src/index.js', 'utf8');
const lines = content.split('\n');
lines.forEach((l, i) => {
  if (l.includes("job === 'invite'") || l.includes("kind === 'invite'") || l.includes('fire(') || l.includes('runSchedule(')) {
    console.log((i + 1) + ': ' + l.trim());
  }
});

