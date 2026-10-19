import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const modules = ['dsh-onebot-source', 'dsh-group-social', 'dsh-plugin-memory-source', 'dsh-companion-voice', 'dsh-qq-unified'];
const command = process.argv[2] || 'doctor';
const exists = relative => fs.existsSync(path.join(root, relative));
function run(directory, args) {
  console.log(`\n[${directory}] node ${args.join(' ')}`);
  const result = spawnSync(process.execPath, args, {
    cwd: path.join(root, directory), stdio: 'inherit', shell: false,
  });
  if (result.error) console.error(result.error.message);
  return result.status ?? 1;
}
function checkSources() {
  const missing = modules.filter(name => !exists(`${name}/package.json`));
  if (missing.length) throw new Error(`Missing source modules: ${missing.join(', ')}`);
}
function checkCompiler() {
  const missing = ['dsh-onebot-source/node_modules/typescript/bin/tsc',
    'dsh-onebot-source/node_modules/@deepseek-ai/dsh-agent/package.json']
    .filter(file => !exists(file));
  if (missing.length) throw new Error(`Build prerequisites missing:\n${missing.join('\n')}\nSee docs/DEVELOPMENT.md. No build was started.`);
}
function testFiles(directory) {
  return fs.readdirSync(path.join(root, directory, 'test'))
    .filter(name => name.endsWith('.test.mjs')).sort().map(name => `test/${name}`);
}
try {
  checkSources();
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js >=22 required.');
  if (command === 'doctor') {
    console.log(`Workspace: ${root}\nNode: ${process.version}`);
    for (const name of modules) {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, name, 'package.json'), 'utf8'));
      console.log(`OK ${name}: ${pkg.version}`);
    }
    try { checkCompiler(); console.log('OK compiler and host package entry points present; run typecheck to verify compatibility.'); }
    catch (error) { console.log(`PENDING ${error.message}`); process.exitCode = 1; }
    for (const name of modules.filter(name => exists(`${name}/.git`))) console.log(`NOTE nested Git repository retained: ${name}`);
    console.log('Imported deployment, models and private configuration are not included by the root .gitignore.');
  } else if (command === 'test' || command === 'test-portable') {
    const results = [];
    for (const name of ['dsh-group-social', 'dsh-companion-voice', 'dsh-qq-unified']) {
      results.push([name, run(name, ['--experimental-vm-modules', '--test', ...testFiles(name)])]);
    }
    if (command === 'test') {
      results.push(['memory self-test', run('dsh-plugin-memory-source', ['scripts/memory.mjs', '--self-test'])]);
      results.push(['memory plugin', run('dsh-plugin-memory-source', ['--test', ...testFiles('dsh-plugin-memory-source')])]);
      results.push(['onebot', run('dsh-onebot-source', ['node_modules/vitest/vitest.mjs', 'run'])]);
    }
    console.log('\nResults:');
    for (const [name, status] of results) console.log(`${status === 0 ? 'PASS' : 'FAIL'} ${name}`);
    process.exitCode = results.some(([, status]) => status !== 0) ? 1 : 0;
  } else if (command === 'typecheck' || command === 'build') {
    checkCompiler();
    const args = ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'];
    if (command === 'typecheck') args.push('--noEmit');
    process.exitCode = run('dsh-onebot-source', args);
    if (process.exitCode === 0 && command === 'build') process.exitCode = run('dsh-qq-unified', ['build.mjs']);
  } else if (command === 'bundle') {
    console.log('Packaging existing lib/ files only. This does not compile or validate TypeScript source.');
    for (const name of ['dsh-onebot-source', 'dsh-group-social', 'dsh-companion-voice']) {
      if (!exists(`${name}/lib`)) throw new Error(`Missing ${name}/lib`);
    }
    process.exitCode = run('dsh-qq-unified', ['build.mjs']);
  } else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
