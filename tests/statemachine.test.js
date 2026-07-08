import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, STATE_PREFIX, stateOf } from '../src/statemachine.js';

test('ready → plan (label-first: to=planning)', () => {
  assert.deepEqual(decide('midas:state:ready'), { action: 'plan', from: 'midas:state:ready', to: 'midas:state:planning' });
});

test('planning → plan (резюме после падения демона, без дубля перехода)', () => {
  assert.deepEqual(decide('midas:state:planning'), { action: 'plan', from: 'midas:state:planning', to: 'midas:state:planning' });
});

test('coding → work', () => {
  assert.deepEqual(decide('midas:state:coding'), { action: 'work', from: 'midas:state:coding', to: 'midas:state:coding' });
});

test('review → review', () => {
  assert.deepEqual(decide('midas:state:review'), { action: 'review', from: 'midas:state:review', to: 'midas:state:review' });
});

test('blocked терминален для автоматики', () => {
  assert.equal(decide('midas:state:blocked'), null);
});

test('awaiting-approval — скип-состояние (гейт): демон не трогает, ждёт внешнего relabel', () => {
  // Как blocked: отсутствие в TABLE = пауза. mon флипает лейбл (approve→coding / reject→rejected).
  assert.equal(decide('midas:state:awaiting-approval'), null);
});

test('accepted/rejected — не трогаем', () => {
  assert.equal(decide('midas:state:accepted'), null);
  assert.equal(decide('midas:state:rejected'), null);
});

test('неизвестный/отсутствующий state — null', () => {
  assert.equal(decide('midas:state:nonsense'), null);
  assert.equal(decide(undefined), null);
});

test('stateOf вытаскивает единственный state-лейбл', () => {
  assert.equal(stateOf([{ name: 'bug' }, { name: 'midas:state:ready' }]), 'midas:state:ready');
  assert.equal(stateOf([{ name: 'bug' }]), null);
});

test('stateOf: два state-лейбла — противоречие, null (не угадываем)', () => {
  assert.equal(stateOf([{ name: 'midas:state:ready' }, { name: 'midas:state:coding' }]), null);
});

test('STATE_PREFIX экспортирован', () => {
  assert.equal(STATE_PREFIX, 'midas:state:');
});
