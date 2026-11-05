import { test } from 'node:test';
import assert from 'node:assert/strict';
import { styleFromAnalysis, uniqueName } from './videoStyle';
import { sanitizeStyle } from './presets';

const answer = {
  name: 'Snabb och färgstark',
  summary: 'Två ord i taget i gul och vit text, hårda klipp och en zoom på varje poäng.',
  aspect: '9:16',
  layout: 'follow_speaker',
  captions_shown: true,
  caption_preset: 'pop',
  caption_font: 'anton',
  caption_uppercase: true,
  caption_words: 2,
  caption_size: 'large',
  caption_position: 'middle',
  text_color: '#ffffff',
  highlight_color: '#ffe14d',
  emphasis_color: 'grön',
  emojis: 'often',
  hook_title: 'first_seconds',
  fillers_removed: true,
  pauses_removed: true,
  zoom_level: 'strong',
  zoom_style: 'cut',
  cut_transition: 'other',
  cut_transition_other: 'snabb vit swipe',
  broll: 'often',
  music: true,
  music_mood: 'energisk hiphop',
  music_volume: 'medium',
  sound_effects: ['whoosh', 'pop'],
  progress_bar: true,
  progress_color: '#FF4D4D',
  progress_position: 'top',
  other_effects: ['varm färgsättning'],
};

test('Gemini\'s answer becomes a template in our own settings', () => {
  const { name, style, origin } = styleFromAnalysis(answer, 'Min favoritvideo');
  assert.equal(name, 'Snabb och färgstark');
  assert.equal(style.captions.preset, 'pop');
  assert.equal(style.captions.font, 'anton');
  assert.equal(style.captions.maxWords, 2);
  assert.equal(style.captions.size, 1.15);
  assert.equal(style.captions.position, 0.5);
  assert.equal(style.captions.textColor, '#FFFFFF');
  assert.equal(style.captions.highlightColor, '#FFE14D');
  // Not a colour: the preset's own.
  assert.equal(style.captions.emphasisColor, '#4ADE80');
  assert.equal(style.captions.emojis, true);
  assert.deepEqual(style.title, { enabled: true, duration: 'intro' });
  assert.equal(style.zoom, 'strong');
  assert.equal(style.zoomStyle, 'cut');
  assert.equal(style.transition, 'none');
  assert.deepEqual(style.progress, { enabled: true, color: '#FF4D4D', position: 'top' });
  assert.equal(style.removeFillers, true);
  assert.equal(style.removePauses, true);
  // It's a valid style the brand kit will keep.
  assert.ok(sanitizeStyle(style));
  assert.equal(origin.from, 'Min favoritvideo');
  // What to do by hand, and what the app can't do.
  const notes = origin.notes.join('\n');
  assert.match(notes, /Formatet är 9:16/);
  assert.match(notes, /B-roll ofta/);
  assert.match(notes, /Musik: energisk hiphop, mellan volym/);
  assert.match(notes, /Ljudeffekter \(whoosh, pop\) kan appen inte/);
  assert.match(notes, /Övergången vid klippen \(snabb vit swipe\) finns inte/);
  assert.match(notes, /Kan inte göras än: varm färgsättning/);
});

test('a broken or empty answer still gives a usable template', () => {
  const { name, style, origin } = styleFromAnalysis({ caption_preset: 'comic', caption_font: 'u-abc', caption_words: 99, zoom_level: 'max' }, '');
  assert.equal(name, 'Stil från video');
  assert.equal(style.captions.preset, 'karaoke');
  assert.equal(style.captions.font, 'montserrat');
  assert.equal(style.captions.maxWords, 8);
  assert.equal(style.zoom, 'off');
  assert.equal(style.title.enabled, false);
  assert.equal(origin.from, 'en video');
  assert.ok(sanitizeStyle(style));
  assert.ok(styleFromAnalysis(null, 'x').style.captions.enabled);
});

test('a name the AI made up never replaces one of your templates', () => {
  assert.equal(uniqueName('Podd', ['Gaming']), 'Podd');
  assert.equal(uniqueName('Podd', ['podd', 'Podd 2']), 'Podd 3');
});
