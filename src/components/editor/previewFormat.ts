/** 'webm' for the few browsers that can't play H.264 (some Chromium builds), else 'mp4'. */
export function previewFormat(): 'mp4' | 'webm' {
  if (typeof document === 'undefined') return 'mp4';
  const video = document.createElement('video');
  const h264 = video.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
  const vp9 = video.canPlayType('video/webm; codecs="vp9, opus"');
  return !h264 && vp9 ? 'webm' : 'mp4';
}
