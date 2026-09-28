import { test } from 'node:test';
import assert from 'node:assert/strict';
import { framingFilterArgs, keyframesToCropXExpr, type Framing } from './smartCrop';

const dims = { width: 1920, height: 1080 };
const captions = "ass=filename='clip.ass'";

test('a single keyframe is a fixed crop position, clamped to the frame', () => {
  assert.equal(keyframesToCropXExpr([{ t: 0, cx: 0.5, cut: true }], 606, 1920), '657');
  assert.equal(keyframesToCropXExpr([{ t: 0, cx: 0.01, cut: true }], 606, 1920), '0');
  assert.equal(keyframesToCropXExpr([{ t: 0, cx: 0.99, cut: true }], 606, 1920), '1314');
});

test('cuts jump and pans interpolate between keyframes', () => {
  const expr = keyframesToCropXExpr(
    [
      { t: 0, cx: 0.25, cut: true },
      { t: 2, cx: 0.3, cut: false }, // pan
      { t: 5, cx: 0.75, cut: true }, // cut
    ],
    606,
    1920,
  );
  assert.equal(expr, 'if(lt(t,2),177+96*(t-0)/2,if(lt(t,5),273,1137))');
});

test('single layout: one filter chain with an even 9:16 crop', () => {
  const framing: Framing = { layout: 'single', dims, keyframes: [{ t: 0, cx: 0.5, cut: true }] };
  const [flag, filter] = framingFilterArgs(framing, captions);
  assert.equal(flag, '-vf');
  assert.match(filter, /^crop=w=606:h=1080:x='657':y=0,scale=1080:1920,setsar=1,ass=/);
});

test('letterbox layout scales and pads a narrow source', () => {
  const framing: Framing = { layout: 'letterbox', dims: { width: 1080, height: 1920 } };
  const [flag, filter] = framingFilterArgs(framing, captions);
  assert.equal(flag, '-vf');
  assert.match(filter, /force_original_aspect_ratio=decrease,pad=1080:1920/);
  assert.ok(filter.endsWith(captions));
});

test('split layout stacks two 1080x960 crops and maps the result', () => {
  const framing: Framing = {
    layout: 'split',
    dims,
    top: { keyframes: [{ t: 0, cx: 0.2, cut: true }], y: 0.1, h: 0.5 },
    bottom: { keyframes: [{ t: 0, cx: 0.8, cut: true }], y: 0.9, h: 0.5 }, // y too low: clamped
  };
  const args = framingFilterArgs(framing, captions);
  assert.equal(args[0], '-filter_complex');
  const graph = args[1];
  // 540 px tall crops (half the frame), 9:8 wide: 606 px.
  assert.match(graph, /\[first\]crop=w=606:h=540:x='81':y=108,scale=1080:960\[top\]/);
  assert.match(graph, /\[second\]crop=w=606:h=540:x='1233':y=540,scale=1080:960\[bottom\]/);
  assert.match(graph, /\[top\]\[bottom\]vstack=inputs=2,setsar=1,ass=.*\[out\]$/);
  assert.deepEqual(args.slice(2), ['-map', '[out]', '-map', '0:a?']);
});
