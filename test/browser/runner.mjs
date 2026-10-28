// Executes one plugin node script like SP's direct executor. Reads JSON from stdin.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', async () => {
  const { script, args } = JSON.parse(input);
  const sandbox = {
    require: (m) => {
      if (m === 'fs') return fs;
      if (m === 'path') return path;
      if (m === 'os') return os;
      throw new Error(`Module '${m}' is not allowed`);
    },
    console,
    JSON,
    args: args || [],
    __result: undefined,
  };
  try {
    const ctx = vm.createContext(sandbox);
    await vm.runInContext(
      `(async function() { const result = await (async function() { ${script} })(); __result = result; })()`,
      ctx,
      { timeout: 5000 },
    );
    process.stdout.write(JSON.stringify({ success: true, result: sandbox.__result }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ success: false, error: String(e && e.message) }));
  }
});
