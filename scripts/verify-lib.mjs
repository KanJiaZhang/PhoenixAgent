/**
 * The small harness both verification scripts share.
 *
 * A verification script here is a list of assertions that can fail, each printed with the number it checked.
 * It exits non-zero on the first failure and prints how many passed - the same shape PhoenixGraph's
 * `verification/*.mjs` scripts use, so a reviewer reads one style in both repositories.
 */

let passed = 0;
let failed = 0;
const failures = [];

export function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

export function checkEqual(name, actual, expected) {
  check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export function checkClose(name, actual, expected, tolerance) {
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance * Math.max(Math.abs(expected), 1);
  check(name, ok, `expected ${expected} ± ${tolerance}, got ${actual}`);
}

export function section(title) {
  console.log(`\n${title}`);
}

export function summary(title) {
  console.log(`\n${title}: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`  failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  process.exit(0);
}

export function skip(reason) {
  console.log(`SKIP ${reason}`);
  process.exit(0);
}
