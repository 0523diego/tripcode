import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { forbiddenForAgent } from './guard.ts';

describe('forbiddenForAgent', () => {
  test('refuses reading the private home in any tool', () => {
    assert.ok(forbiddenForAgent('Read', { file_path: '/Users/someone/.tripcode/chrome-profile/Default/Cookies' }));
    assert.ok(forbiddenForAgent('Bash', { command: 'cat ~/.tripcode/activity.jsonl' }));
    assert.ok(forbiddenForAgent('Bash', { command: 'ls $HOME/.tripcode' }));
    assert.ok(forbiddenForAgent('Bash', { command: 'TRIPCODE_HOME=/tmp/x node cli/tripcode.ts list' }));
    assert.ok(forbiddenForAgent('Grep', { pattern: 'number', path: '/home/me/.tripcode/chrome-profile' }));
  });

  test('leaves watches, reading pages and the project cache alone', () => {
    assert.equal(forbiddenForAgent('Bash', { command: 'npm run tripcode -- buy watch add rome --id x' }), undefined);
    assert.equal(forbiddenForAgent('Bash', { command: 'npm run tripcode -- buy scan rome' }), undefined);
    assert.equal(forbiddenForAgent('Bash', { command: 'npm run tripcode -- buy browser open https://www.louvre.fr/' }), undefined);
    assert.equal(forbiddenForAgent('Read', { file_path: '/p/tripcode/node_modules/.tripcode/current.json' }), undefined);
    assert.equal(forbiddenForAgent('Read', { file_path: '/p/tripcode/trips/rome/purchase/watches.json' }), undefined);
  });
});
