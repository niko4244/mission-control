#!/usr/bin/env node
/**
 * seed-domain-knowledge.cjs
 * Seeds real domain knowledge for appliance and coding domains.
 * Writes directly via memory-service writeMemory — no scoring side effects.
 * Run once: node scripts/seed-domain-knowledge.cjs
 */
'use strict';

const memoryService = require('./memory-service.cjs');

const SOURCE = 'cli';
const CATEGORY = 'execution';
const AGENT = 'cli';

const entries = [
  // ===== APPLIANCE — Compressor / Cooling =====
  {
    content: 'Compressor not running but clicking: start relay or run capacitor has failed. Replace start relay first — it is the cheaper component and fails more often.',
    tags: 'domain:appliance,component:compressor,symptom:clicking,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:appliance',
  },
  {
    content: 'Compressor hums but does not start: overload protector tripped or capacitor weak. Let unit cool 30 minutes then retest before replacing capacitor.',
    tags: 'domain:appliance,component:compressor,symptom:hum,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:appliance',
  },
  {
    content: 'Thermal fuse blown on dryer: root cause is almost always restricted airflow — clogged lint trap or kinked vent duct. Replace fuse AND clear vent or fuse will blow again.',
    tags: 'domain:appliance,component:thermal-fuse,symptom:blown-fuse,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:appliance',
  },
  {
    content: 'Thermal fuse blowing repeatedly on dryer indicates heater element shorted to ground or cycling thermostat stuck closed. Test thermostat continuity at room temperature — should read open.',
    tags: 'domain:appliance,component:thermal-fuse,symptom:repeated-failure,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:appliance',
  },
  {
    content: 'Dryer overheating: first check exhaust vent for blockage — a fully clogged vent can raise drum temperature above 180F. Secondary cause is failed cycling thermostat that no longer cycles heater off.',
    tags: 'domain:appliance,component:dryer,symptom:overheating,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:appliance',
  },
  {
    content: 'Dryer runs but produces no heat: check thermal fuse continuity first (no continuity = blown). If fuse is good, test heating element for continuity. On gas dryers check igniter resistance (should be 50-400 ohms).',
    tags: 'domain:appliance,component:dryer,symptom:no-heat,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:appliance',
  },
  {
    content: 'Refrigerator compressor short-cycling (turns on/off rapidly): condenser coils dirty or condenser fan not running. Clean coils and verify fan motor spins freely.',
    tags: 'domain:appliance,component:compressor,symptom:short-cycling,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:appliance',
  },
  {
    content: 'Warm discharge line on compressor with poor cooling indicates low refrigerant charge or inefficient compressor. Measure suction pressure — below 25 PSI on R-134a suggests low charge.',
    tags: 'domain:appliance,component:compressor,symptom:warm-discharge,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:appliance',
  },
  {
    content: 'Washer not spinning: lid switch failure is the most common cause on top-loaders. Test lid switch continuity — no continuity with lid closed means switch is bad.',
    tags: 'domain:appliance,component:washer,symptom:not-spinning,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:appliance',
  },
  {
    content: 'Control board failure on appliance: always check for burned relay contacts and swollen capacitors before replacing full board. Targeted component repair is 10x cheaper.',
    tags: 'domain:appliance,component:control-board,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:appliance',
  },

  // ===== CODING DOMAIN — Timeouts / Async =====
  {
    content: 'Timeout error in Node.js: most common cause is an async operation without await, or a promise that never resolves. Add timeout wrapper with Promise.race() to surface the stall.',
    tags: 'domain:coding,language:nodejs,symptom:timeout,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:coding',
  },
  {
    content: 'Node.js script hangs on exit: likely an open handle (timer, socket, database connection) preventing process from terminating. Use --inspect-brk and check libuv handles, or add process.exit() after main.',
    tags: 'domain:coding,language:nodejs,symptom:hang,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:coding',
  },
  {
    content: 'ETIMEDOUT in Node.js HTTP request: default socket timeout is none. Set socket.setTimeout() or use AbortController with AbortSignal.timeout(). Unhandled timeout causes silent hang.',
    tags: 'domain:coding,language:nodejs,symptom:etimedout,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:coding',
  },

  // ===== CODING DOMAIN — Agent Loops =====
  {
    content: 'Agent loop not terminating: missing exit condition or task generates a subtask that re-enqueues the parent. Add max-iteration guard and log iteration count on every cycle.',
    tags: 'domain:coding,component:agent,symptom:infinite-loop,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:coding',
  },
  {
    content: 'Infinite loop in agent execution: check whether the done condition tests a value that the loop body actually modifies. Common bug is testing a const or a stale closure reference.',
    tags: 'domain:coding,component:agent,symptom:infinite-loop,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:coding',
  },
  {
    content: 'Agent recursively spawning tasks: add a depth counter to each task context and refuse to spawn if depth exceeds configured limit. Log the full task chain when limit is hit.',
    tags: 'domain:coding,component:agent,symptom:recursive-spawn,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:coding',
  },
  {
    content: 'Agent loop terminates too early: exit condition triggers on first result before all parallel branches complete. Wait for Promise.allSettled() instead of the first resolve.',
    tags: 'domain:coding,component:agent,symptom:early-exit,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:coding',
  },

  // ===== CODING DOMAIN — React / UI =====
  {
    content: 'React UI not rendering after state update: state object was mutated in place instead of replaced. React uses reference equality — always return a new object/array from setState.',
    tags: 'domain:coding,framework:react,symptom:not-rendering,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:coding',
  },
  {
    content: 'Component not re-rendering despite state change: check that state is stored with useState or useReducer, not a plain variable. Plain variables do not trigger re-render.',
    tags: 'domain:coding,framework:react,symptom:no-rerender,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:coding',
  },
  {
    content: 'Stale props or state inside event handler: event handler closed over the initial value. Use useRef to hold mutable state that must be current at call time, or use functional setState update form.',
    tags: 'domain:coding,framework:react,symptom:stale-closure,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:coding',
  },
  {
    content: 'UI shows blank after navigation: component throws during render and error boundary is not set up. Wrap route components in ErrorBoundary to get the actual error rather than a blank screen.',
    tags: 'domain:coding,framework:react,symptom:blank-screen,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:coding',
  },

  // ===== CODING DOMAIN — Databases / Connections =====
  {
    content: 'Database connection timeout: connection pool exhausted — queries queued waiting for a free slot. Increase pool size or find long-running transactions that are holding connections.',
    tags: 'domain:coding,component:database,symptom:connection-timeout,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:coding',
  },
  {
    content: 'SQLite SQLITE_BUSY error: another process has a write lock. Use WAL mode (PRAGMA journal_mode=WAL) to allow concurrent reads with one writer.',
    tags: 'domain:coding,component:database,symptom:busy-lock,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:coding',
  },

  // ===== CODING DOMAIN — Memory / Process =====
  {
    content: 'Node.js heap out of memory: check for unbounded arrays or event emitters with growing listener lists. Use --expose-gc and heapdump to capture allocation snapshot.',
    tags: 'domain:coding,language:nodejs,symptom:oom,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:coding',
  },
  {
    content: 'Memory leak in long-running agent: closures holding references to large objects prevent GC. Common pattern: callback array that appends but never clears between runs.',
    tags: 'domain:coding,component:agent,symptom:memory-leak,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:coding',
  },

  // ===== APPLIANCE — Additional gap coverage =====
  {
    content: 'Refrigerator not cooling but compressor running: evaporator fan not running or frosted-over evaporator coils. Open freezer panel — if coils are ice-blocked, defrost heater or defrost thermostat has failed.',
    tags: 'domain:appliance,component:refrigerator,symptom:not-cooling,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:appliance',
  },
  {
    content: 'Dishwasher not draining: drain pump clogged with debris or drain check valve stuck closed. Remove pump cover and clear obstruction before replacing pump motor.',
    tags: 'domain:appliance,component:dishwasher,symptom:not-draining,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:appliance',
  },
  {
    content: 'Oven temperature inaccurate: bake element or broil element partially failed — element glows only on part of its length. Full continuity reading but visual inspection reveals hot spots.',
    tags: 'domain:appliance,component:oven,symptom:temperature-inaccurate,outcome:unknown',
    sourceRef: 'source:domain-seed|domain:appliance',
  },
];

let inserted = 0;
let skipped = 0;

for (const entry of entries) {
  try {
    const result = memoryService.writeMemory(SOURCE, CATEGORY, entry.content, {
      agent: AGENT,
      tags: entry.tags,
      sourceRef: entry.sourceRef,
    });
    console.log(`  inserted id=${result.id}: ${entry.content.slice(0, 70)}...`);
    inserted++;
  } catch (err) {
    console.error(`  FAILED: ${err.message} — ${entry.content.slice(0, 60)}`);
    skipped++;
  }
}

console.log(`\nDone. Inserted: ${inserted}, Skipped: ${skipped}`);
