import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from './config';
import { brandInfo, brandTemplate, removeTemplate, renameTemplate, saveTemplate } from './brand';
import { defaultEdit, styleOf, withStyle } from './edit/presets';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-brand-'));
Object.assign(config, { brandDir: dir });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const edit = defaultEdit({ start: 0, end: 10, title: 'Hej', captionPreset: 'neon' });
const look = styleOf({ ...edit, zoom: 'medium', progress: { enabled: true, color: '#FF0000', position: 'top' } });

test('templates are saved with a name, and the same name replaces it', () => {
  assert.throws(() => saveTemplate('  ', look), /namn/);
  assert.throws(() => saveTemplate('Podd', { nope: true }), /textinställningar/);
  const podd = saveTemplate('  Podd   avsnitt ', look);
  assert.match(podd.id, /^t-[0-9a-f]{12}$/);
  assert.equal(podd.name, 'Podd avsnitt');
  assert.equal(podd.zoom, 'medium');
  assert.deepEqual(podd.progress, { enabled: true, color: '#FF0000', position: 'top' });
  const again = saveTemplate('podd AVSNITT', styleOf(edit));
  assert.equal(again.id, podd.id);
  assert.equal(brandInfo().templates?.length, 1);
  assert.equal(brandTemplate(podd.id)?.progress?.enabled, false);
  // It survives a reload from disk.
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'brand.json'), 'utf8'));
  assert.equal(saved.templates[0].name, 'podd AVSNITT');
});

test('templates can be renamed and removed', () => {
  const gaming = saveTemplate('Gaming', look);
  const podd = brandInfo().templates?.find((t) => t.id !== gaming.id);
  assert.ok(podd);
  assert.throws(() => renameTemplate(gaming.id, podd.name), /redan en mall/);
  assert.equal(renameTemplate(gaming.id, 'Spel').name, 'Spel');
  assert.throws(() => renameTemplate('t-000000000000', 'X'), /finns inte/);
  assert.equal(removeTemplate(gaming.id), true);
  assert.equal(removeTemplate(gaming.id), false);
  assert.deepEqual(brandInfo().templates?.map((t) => t.id), [podd.id]);
});

test('a template on a clip gives it the text, zoom and progress bar', () => {
  const template = saveTemplate('Stark', look);
  const styled = withStyle(defaultEdit({ start: 0, end: 10, title: 'Hej' }), template, false);
  assert.equal(styled.captions.preset, 'neon');
  assert.equal(styled.zoom, 'medium');
  assert.deepEqual(styled.progress, { enabled: true, color: '#FF0000', position: 'top' });
  // An older Min stil without zoom or a bar leaves the clip's own.
  const { zoom: _zoom, progress: _progress, ...old } = template;
  const kept = withStyle({ ...defaultEdit({ start: 0, end: 10, title: 'Hej' }), zoom: 'light' }, old, false);
  assert.equal(kept.zoom, 'light');
  assert.equal(kept.progress.enabled, false);
});
