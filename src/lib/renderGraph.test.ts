import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRenderGraph, keyframesToCropXExpr, type RenderGraphInput } from './renderGraph';

const source = { width: 1920, height: 1080, duration: 600, hasAudio: true };
const captionsFilter = "ass=filename='clip.ass'";

function input(patch: Partial<RenderGraphInput>): RenderGraphInput {
  return {
    source,
    out: { w: 1080, h: 1920 },
    layout: 'single',
    keyframes: [{ t: 0, cx: 0.5, cut: true }],
    kept: [{ start: 0, end: 5 }],
    length: 5,
    hasAudio: true,
    captionsFilter,
    ...patch,
  };
}

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

test('single layout: an even 9:16 crop, captions, and the audio as it is', () => {
  const { graph, maps } = buildRenderGraph(input({}));
  assert.equal(graph, `[0:v]crop=w=606:h=1080:x='657':y=0,scale=1080:1920,setsar=1,${captionsFilter}[vout]`);
  assert.deepEqual(maps, ['-map', '[vout]', '-map', '0:a:0']);
});

test('other formats crop to their own shape', () => {
  const square = buildRenderGraph(input({ out: { w: 1080, h: 1080 } })).graph;
  assert.match(square, /^\[0:v\]crop=w=1080:h=1080:x='420':y=0,scale=1080:1080,/);
  // A portrait source in 16:9: a fixed band a bit above the middle.
  const band = buildRenderGraph(
    input({ source: { ...source, width: 1080, height: 1920 }, out: { w: 1920, h: 1080 } }),
  ).graph;
  assert.match(band, /^\[0:v\]crop=w=1080:h=606:x=0:y=460,scale=1920:1080,/);
});

test('fit layout: the whole frame over a blurred copy of itself', () => {
  const { graph } = buildRenderGraph(
    input({ layout: 'fit', source: { ...source, width: 1080, height: 1350 } }),
  );
  assert.match(graph, /^\[0:v\]split=2\[bgsrc\]\[fgsrc\];\[bgsrc\]scale=108:192:force_original_aspect_ratio=increase,crop=108:192,boxblur=4:2,scale=1080:1920,lutyuv=y=val\*0\.7\[bg\];/);
  assert.match(graph, /\[fgsrc\]scale=1080:1350\[fg\];\[bg\]\[fg\]overlay=0:285,setsar=1,/);
});

test('split layout stacks two crops of half the output height', () => {
  const { graph } = buildRenderGraph(
    input({
      layout: 'split',
      split: {
        top: { keyframes: [{ t: 0, cx: 0.2, cut: true }], y: 0.1, h: 0.5 },
        bottom: { keyframes: [{ t: 0, cx: 0.8, cut: true }], y: 0.9, h: 0.5 }, // y too low: clamped
      },
    }),
  );
  // 540 px tall crops (half the frame), 9:8 wide: 606 px.
  assert.match(graph, /\[first\]crop=w=606:h=540:x='81':y=108,scale=1080:960\[top\]/);
  assert.match(graph, /\[second\]crop=w=606:h=540:x='1233':y=540,scale=1080:960\[bottom\]/);
  assert.match(graph, /\[top\]\[bottom\]vstack=inputs=2,setsar=1,ass=.*\[vout\]$/);
});

test('cuts keep only the kept frames, close the gaps and join the audio with fades', () => {
  const { graph, maps } = buildRenderGraph(
    input({ kept: [{ start: 0, end: 2 }, { start: 3, end: 5 }] }),
  );
  assert.match(graph, /,select='between\(t,0,2\)\+between\(t,3,5\)',setpts='\(T-\(0\+gte\(T,3\)\*1\)\)\/TB',ass=/);
  assert.match(graph, /;\[0:a:0\]asplit=2\[a0\]\[a1\];/);
  assert.match(graph, /\[a0\]atrim=start=0:end=2,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0\.01,afade=t=out:st=1\.99:d=0\.01\[b0\]/);
  assert.match(graph, /\[a1\]atrim=start=3:end=5,.*\[b1\];\[b0\]\[b1\]concat=n=2:v=0:a=1\[aout\]$/);
  assert.deepEqual(maps, ['-map', '[vout]', '-map', '[aout]']);
});

test('a clip whose first word was removed starts later, audio included', () => {
  const { graph, maps } = buildRenderGraph(input({ kept: [{ start: 0.5, end: 5 }] }));
  assert.match(graph, /select='between\(t,0\.5,5\)',setpts='\(T-\(0\.5\)\)\/TB'/);
  assert.match(graph, /;\[0:a:0\]atrim=start=0\.5:end=5,.*\[b0\]$/);
  assert.deepEqual(maps, ['-map', '[vout]', '-map', '[b0]']);
});

test('no audio track: video only', () => {
  const { maps } = buildRenderGraph(input({ hasAudio: false, kept: [{ start: 0, end: 2 }, { start: 3, end: 5 }] }));
  assert.deepEqual(maps, ['-map', '[vout]']);
});
