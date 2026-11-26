import assert from 'node:assert/strict';
import test from 'node:test';

test('every test runs in UTC, whatever the computer it runs on says', () => {
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'UTC');
  assert.equal(new Date(0).getHours(), 0);
});
