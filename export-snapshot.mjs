#!/usr/bin/env node
// Export flock pipeline queues to data/snapshot.json for the Vercel site.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';

const Q = '/home/hatch/workspace/cardigan-s-hymnlings/hidden_files';
const OUT = '/home/hatch/workspace/muse-pull-site/data/snapshot.json';

function load(name) {
  const p = `${Q}/${name}`;
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : []; }
  catch { return []; }
}

function lastActivity(arr, key) {
  if (!arr.length) return null;
  const last = arr[arr.length - 1];
  return last[key] || null;
}

const scout = load('scout-queue.json');
const invest = load('investigation-queue.json');
const scores = load('social-scores.json');
const decisions = load('decision-queue.json');

const scouts = [...new Set(scout.map(x => x.scout).filter(Boolean))];

// key status: which provider credentials are configured (no values, just booleans)
let key_status = {};
try {
  const { execSync } = await import('child_process');
  for (const [provider, cred] of [['openai','custom.openai-cardigan'],['anthropic','custom.anthropic-cardigan'],['xai','custom.xai-cardigan']]) {
    try {
      const out = execSync(`python3 -c "
import sys
sys.path.insert(0, '/opt/hatch/skills/skill-creator/bin')
from dynamic_credentials import get_surrogate_token
t = get_surrogate_token('${cred}')
print('ok' if t and len(t) > 8 else 'no')
"`, { encoding: 'utf8', timeout: 10000 }).trim();
      key_status[provider] = out === 'ok';
    } catch { key_status[provider] = false; }
  }
} catch { key_status = {}; }

const snapshot = {
  updated_at: new Date().toISOString(),
  key_status,
  scout_queue: scout,
  investigations: invest,
  scores,
  decisions,
  scouts,
  last_activity: {
    scout: lastActivity(scout, 'found_at'),
    hymn: lastActivity(invest, 'investigated_at'),
    scorer: lastActivity(scores, 'scored_at'),
    snug: lastActivity(decisions, 'broken_down_at'),
    cardigan: lastActivity(decisions, 'broken_down_at'),
  },
};

mkdirSync('/home/hatch/workspace/muse-pull-site/data', { recursive: true });
writeFileSync(OUT, JSON.stringify(snapshot, null, 1));
console.log('snapshot written:', snapshot.updated_at, '| scouts:', scout.length, '| invest:', invest.length, '| scores:', scores.length, '| decisions:', decisions.length);
