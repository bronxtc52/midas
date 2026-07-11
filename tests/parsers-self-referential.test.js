// Регресс инцидента midas#9 / PR #27: self-referential дифф (PR про сами парсеры)
// содержит строки-шаблоны `VERDICT: {...}` / `DOD: {...}`; сессия цитирует их
// ПОСЛЕ настоящего маркера, и lastIndexOf хватал цитату → unparsed × 2 → blocked
// на здоровом PR. Новый контракт: последнее ПАРСИБЕЛЬНОЕ line-anchored вхождение.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict } from '../src/roles/reviewer.js';
import { parseDod } from '../src/roles/acceptor.js';
import { parseLastMarkedJson } from '../src/roles/common.js';

const REAL_VERDICT = 'VERDICT: {"verdict":"pass","findings":[]}';
const TEMPLATE_VERDICT = 'VERDICT: {"verdict":"pass|fail","findings":[...]}'; // невалидный JSON — как в промпте/диффе

test('parseVerdict: цитата шаблона ПОСЛЕ настоящего вердикта → парсится настоящий (регресс PR #27)', () => {
  const out = [
    'Ревью выполнено, замечаний нет.',
    REAL_VERDICT,
    'Замечу: формат вердикта в reviewer.js описан строкой:',
    TEMPLATE_VERDICT,
  ].join('\n');
  const v = parseVerdict(out);
  assert.equal(v.verdict, 'pass');
  assert.ok(!v.unparsed);
});

test('parseVerdict: валидная цитата в середине строки/бэктиках игнорируется (не line-anchored)', () => {
  const out = [
    'Настоящий вердикт:',
    'VERDICT: {"verdict":"fail","findings":[{"severity":"high","note":"x"}]}',
    'в коде встречается `VERDICT: {"verdict":"pass","findings":[]}` — это цитата.',
  ].join('\n');
  const v = parseVerdict(out);
  assert.equal(v.verdict, 'fail'); // mid-line «pass»-цитата не перебила настоящий fail
  assert.ok(!v.unparsed);
});

test('parseVerdict: несколько line-anchored вхождений, валидное только первое → берётся оно', () => {
  const out = [
    REAL_VERDICT,
    TEMPLATE_VERDICT,
    'VERDICT: вовсе не json',
  ].join('\n');
  const v = parseVerdict(out);
  assert.equal(v.verdict, 'pass');
  assert.ok(!v.unparsed);
});

test('parseVerdict: ни одного валидного вхождения → unparsed (fail-closed сохранён)', () => {
  const v = parseVerdict([TEMPLATE_VERDICT, 'VERDICT: {"verdict":"maybe","findings":[]}'].join('\n'));
  assert.equal(v.verdict, 'fail');
  assert.ok(v.unparsed);
});

test('parseVerdict: маркер с отступом (line-anchored с ведущими пробелами) парсится', () => {
  const v = parseVerdict('  VERDICT: {"verdict":"pass","findings":[]}');
  assert.equal(v.verdict, 'pass');
  assert.ok(!v.unparsed);
});

const REAL_DOD = 'DOD: {"items":[{"item":"a","pass":true,"evidence":"e"}]}';
const TEMPLATE_DOD = 'DOD: {"items":[{"item":"...","pass":true|false,"evidence":"..."}]}';

test('parseDod: цитата шаблона ПОСЛЕ настоящего DOD → парсится настоящий', () => {
  const d = parseDod(['Проверил каждый пункт.', REAL_DOD, 'Формат в acceptor.js:', TEMPLATE_DOD].join('\n'));
  assert.ok(!d.unparsed);
  assert.equal(d.items.length, 1);
  assert.equal(d.items[0].pass, true);
});

test('parseDod: валидная цитата в середине строки игнорируется', () => {
  const d = parseDod([
    REAL_DOD,
    'фикстура теста: `DOD: {"items":[{"item":"fake","pass":false,"evidence":"f"}]}` — цитата.',
  ].join('\n'));
  assert.ok(!d.unparsed);
  assert.equal(d.items[0].item, 'a'); // взят настоящий, не mid-line цитата
});

test('parseDod: ни одного валидного вхождения → unparsed', () => {
  const d = parseDod([TEMPLATE_DOD, 'DOD: {"items":"не массив"}'].join('\n'));
  assert.ok(d.unparsed);
});

test('parseLastMarkedJson: нет вхождений → null; пустой текст/null → null', () => {
  assert.equal(parseLastMarkedJson('обычный текст', 'VERDICT:', () => true), null);
  assert.equal(parseLastMarkedJson('', 'VERDICT:', () => true), null);
  assert.equal(parseLastMarkedJson(null, 'VERDICT:', () => true), null);
});
