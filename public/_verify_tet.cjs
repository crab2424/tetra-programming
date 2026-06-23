const fs = require('fs');
const MS = /^    (?:get |set )?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/;
const ME = /^    \},?$/;
function parse(bodyLines) {
    const out = {}; let i = 0;
    while (i < bodyLines.length) {
        const m = MS.exec(bodyLines[i]);
        if (m) {
            let j = i; for (; j < bodyLines.length; j++) if (ME.test(bodyLines[j])) break;
            const lines = bodyLines.slice(i, j + 1);
            lines[lines.length - 1] = lines[lines.length - 1].replace(/^    \},$/, '    }');
            out[m[1]] = lines.join('\n'); i = j + 1;
        } else i++;
    }
    return out;
}
const orig = fs.readFileSync('src/game.js', 'utf8').split('\n');
const cs = orig.findIndex(l => /^class Game \{/.test(l));
let ce = -1; for (let i = cs + 1; i < orig.length; i++) if (orig[i] === '}') { ce = i; break; }
const O = parse(orig.slice(cs + 1, ce));
const S = {};
for (const f of ['core','lifecycle','board','rotation','scoring','garbage','render','input'])
    Object.assign(S, parse(fs.readFileSync(`src/tet/${f}.js`,'utf8').split('\n')));
const on = Object.keys(O), sn = Object.keys(S);
const missing = on.filter(n => !(n in S));
const extra = sn.filter(n => !(n in O));
const mismatch = on.filter(n => S[n] !== undefined && S[n] !== O[n]);
console.log('orig:', on.length, ' split:', sn.length);
console.log('missing:', missing, ' extra:', extra, ' mismatch:', mismatch);
console.log(!missing.length && !extra.length && !mismatch.length ? 'PERFECT MATCH ✅' : 'DIFF ❌');
