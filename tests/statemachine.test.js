import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, STATE_PREFIX, stateOf } from '../src/statemachine.js';

test('ready → plan (label-first: to=planning)', () => {
  assert.deepEqual(decide('state:ready'), { action: 'plan', from: 'state:ready', to: 'state:planning' });
});

test('planning → plan (резюме после падения демона, без дубля перехода)', () => {
  assert.deepEqual(decide('state:planning'), { action: 'plan', from: 'state:planning', to: 'state:planning' });
});

test('coding → work', () => {
  assert.deepEqual(decide('state:coding'), { action: 'work', from: 'state:coding', to: 'state:coding' });
});

test('review → review', () => {
  assert.deepEqual(decide('state:review'), { action: 'review', from: 'state:review', to: 'state:review' });
});

test('blocked терминален для автоматики', () => {
  assert.equal(decide('state:blocked'), null);
});

test('accepted/rejected — не трогаем', () => {
  assert.equal(decide('state:accepted'), null);
  assert.equal(decide('state:rejected'), null);
});

test('неизвестный/отсутствующий state — null', () => {
  assert.equal(decide('state:nonsense'), null);
  assert.equal(decide(undefined), null);
});

test('stateOf вытаскивает единственный state-лейбл', () => {
  assert.equal(stateOf([{ name: 'bug' }, { name: 'state:ready' }]), 'state:ready');
  assert.equal(stateOf([{ name: 'bug' }]), null);
});

test('stateOf: два state-лейбла — противоречие, null (не угадываем)', () => {
  assert.equal(stateOf([{ name: 'state:ready' }, { name: 'state:coding' }]), null);
});

test('STATE_PREFIX экспортирован', () => {
  assert.equal(STATE_PREFIX, 'state:');
});
