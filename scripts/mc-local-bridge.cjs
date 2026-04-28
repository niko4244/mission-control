#!/usr/bin/env node
/**
 * Mission Control Local Bridge
 * 
 * Safely calls standalone scripts from pnpm mc
 * No duplicated logic - delegates to proven working scripts.
 * 
 * Usage:
 *   node scripts/mc-local-bridge.cjs <script> <args...>
 * 
 * Scripts available:
 *   cli-memory.cjs status|sync|query
 *   cli-agents.cjs task|run
 *   mc-memory-sync.cjs
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const SCRIPTS_DIR = path.join(os.homedir(), 'mission-control', 'scripts');

const SCRIPT_MAP = {
  // Memory commands
  'memory:status': ['cli-memory.cjs', 'status'],
  'memory:sync': ['cli-memory.cjs', 'sync', '--apply'],
  'memory:sync:dry-run': ['cli-memory.cjs', 'sync'],
  'memory:query': ['cli-memory.cjs', 'query'],
  
  // Agent commands  
  'agents:task:create': ['cli-agents.cjs', 'task', 'create'],
  'agents:task:list': ['cli-agents.cjs', 'task', 'list'],
  'agents:task:status': ['cli-agents.cjs', 'task', 'status'],
  'agents:run': ['cli-agents.cjs', 'run', 'hermes'],
  
  // Sync script
  'sync:hermes': ['mc-memory-sync.cjs', 'hermes'],
  'sync:all': ['mc-memory-sync.cjs', 'all'],
};

function parseArgs(args) {
  const out = { script: null, scriptArgs: [], raw: [] };
  
  // Map compound commands: memory status -> memory:status
  if (args[0] === 'memory' && args[1]) {
    const action = args[1];
    if (action === 'status') out.script = 'memory:status';
    else if (action === 'sync') out.script = 'memory:sync';
    else if (action === 'query') {
      out.script = 'memory:query';
      out.scriptArgs = [args[2] || ''];
    }
    out.raw = args.slice(2);
  }
  else if (args[0] === 'task' && args[1]) {
    if (args[1] === 'create') {
      out.script = 'agents:task:create';
      out.scriptArgs = [args.slice(2).join(' ')];
    }
    else if (args[1] === 'list') out.script = 'agents:task:list';
    else if (args[1] === 'status') {
      out.script = 'agents:task:status';
      out.scriptArgs = [args[2]];
    }
  }
  else if (args[0] === 'agents' && args[1] === 'run') {
    if (args[2] === 'hermes') {
      out.script = 'agents:run';
      // Extract --task flag
      const taskIdx = args.indexOf('--task');
      if (taskIdx > -1 && args[taskIdx + 1]) {
        out.scriptArgs = ['--task', args[taskIdx + 1]];
        // Get prompt after task flag
        const promptIdx = args.indexOf(args[taskIdx + 1]) + 1;
        if (promptIdx < args.length && !args[promptIdx].startsWith('--')) {
          out.scriptArgs.push(args[promptIdx]);
        }
      } else {
        // No task - just pass through to get blocked
        out.scriptArgs = [];
      }
    }
  }
  else if (args[0] === 'sync' && args[1]) {
    if (args[1] === 'hermes') out.script = 'sync:hermes';
    else if (args[1] === 'all') out.script = 'sync:all';
  }
  
  return out;
}

function runScript(scriptKey, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const mapping = SCRIPT_MAP[scriptKey];
    if (!mapping) {
      reject(new Error(`Unknown script: ${scriptKey}`));
      return;
    }
    
    const [scriptName, ...defaultArgs] = mapping;
    const scriptPath = path.join(SCRIPTS_DIR, scriptName);
    const allArgs = [...defaultArgs, ...extraArgs];
    
    const child = spawn('node', [scriptPath, ...allArgs], {
      cwd: SCRIPTS_DIR,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    
    child.on('close', (code) => {
      if (code === 0) {
        try {
          // Parse JSON output
          resolve(JSON.parse(stdout));
        } catch {
          // Return raw if not JSON
          resolve({ raw: stdout, code });
        }
      } else {
        reject(new Error(`Script exited with code ${code}: ${stderr}`));
      }
    });
    
    child.on('error', reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(JSON.stringify({
      available: Object.keys(SCRIPT_MAP),
      usage: 'node mc-local-bridge.cjs memory status'
    }));
    return;
  }
  
  const parsed = parseArgs(args);
  
  if (!parsed.script) {
    console.log(JSON.stringify({ error: 'Unknown command format', args }));
    return;
  }
  
  try {
    const result = await runScript(parsed.script, parsed.scriptArgs);
    console.log(JSON.stringify(result));
  } catch (e) {
    console.log(JSON.stringify({ error: e.message }));
    process.exit(1);
  }
}

main();