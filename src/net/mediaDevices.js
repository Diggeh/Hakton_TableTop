/**
 * Audio/video input device enumeration and persisted preference helpers.
 * Guarded for both browser/Electron renderers and headless Node test runs.
 */

export const MEDIA_DEVICES_STORAGE_KEY = 'hakton.mediaDevices.v1';

export function normalizeDeviceId(deviceId) {
  if (typeof deviceId !== 'string') return '';
  const trimmed = deviceId.trim();
  if (!trimmed || trimmed === 'default') return '';
  return trimmed;
}

function getStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadMediaDevicePrefs() {
  try {
    const raw = getStorage()?.getItem(MEDIA_DEVICES_STORAGE_KEY);
    if (!raw) return { audioInputId: '', videoInputId: '' };
    const parsed = JSON.parse(raw);
    return {
      audioInputId: normalizeDeviceId(parsed?.audioInputId),
      videoInputId: normalizeDeviceId(parsed?.videoInputId),
    };
  } catch {
    return { audioInputId: '', videoInputId: '' };
  }
}

export function saveMediaDevicePrefs(patch = {}) {
  const prev = loadMediaDevicePrefs();
  const next = {
    audioInputId:
      'audioInputId' in patch ? normalizeDeviceId(patch.audioInputId) : prev.audioInputId,
    videoInputId:
      'videoInputId' in patch ? normalizeDeviceId(patch.videoInputId) : prev.videoInputId,
  };
  try {
    getStorage()?.setItem(MEDIA_DEVICES_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage quota or private mode errors
  }
  return next;
}

export async function defaultEnumerateDevices() {
  try {
    const mediaDevices = globalThis.navigator?.mediaDevices;
    if (typeof mediaDevices?.enumerateDevices !== 'function') return [];
    const list = await mediaDevices.enumerateDevices();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function partitionMediaDevices(rawDevices = []) {
  const list = Array.isArray(rawDevices) ? rawDevices : [];
  const audioInputs = [];
  const videoInputs = [];
  const seenAudio = new Set();
  const seenVideo = new Set();

  for (const device of list) {
    if (!device || (device.kind !== 'audioinput' && device.kind !== 'videoinput')) {
      continue;
    }
    const rawId = typeof device.deviceId === 'string' ? device.deviceId.trim() : '';
    const isAudio = device.kind === 'audioinput';
    const seen = isAudio ? seenAudio : seenVideo;
    const target = isAudio ? audioInputs : videoInputs;

    if (rawId) {
      if (seen.has(rawId)) continue;
      seen.add(rawId);
    }

    const rawLabel = typeof device.label === 'string' ? device.label.trim() : '';
    const fallbackLabel =
      rawId === 'default'
        ? 'System Default'
        : `${isAudio ? 'Microphone' : 'Camera'} ${target.length + 1}`;

    target.push({
      deviceId: rawId,
      label: rawLabel || fallbackLabel,
      groupId: typeof device.groupId === 'string' ? device.groupId : '',
      isDefault: rawId === 'default',
    });
  }

  return { audioInputs, videoInputs };
}
