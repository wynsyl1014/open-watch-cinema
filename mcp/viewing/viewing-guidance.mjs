export function describeViewingSettings(settings, changed = false) {
  const parts = [];
  if (Number.isFinite(settings?.intervalMs)) parts.push('建议每 ' + settings.intervalMs / 1000 + ' 秒领取一次');
  if (Number.isFinite(settings?.initialBufferMs)) parts.push('开场缓冲 ' + settings.initialBufferMs / 60_000 + ' 分钟');
  return (changed ? '观影设置更新：' : '当前观影设置：') + (parts.join('；') || '尚未设置观影偏好') + '。';
}

export function aiExperienceWarning(item) {
  const aiPackage = item?.aiPackage || null;
  if (!aiPackage) {
    return 'This film has not been prepared for AI viewing yet. Its visual timeline and timed dialogue are unavailable.';
  }
  if (aiPackage.status !== 'ready' && aiPackage.canStartViewing !== true) {
    return 'The film\'s AI viewing materials are not fully ready. Some dialogue or visual moments may be missing.';
  }
  if (aiPackage.dialogueTrack?.status === 'source_missing') {
    return 'Visual material is available, but timed dialogue is missing.';
  }
  if (aiPackage.canStartViewing === true) return null;
  const mode = aiPackage.aiReadiness?.experienceMode || 'raw';
  if (mode === 'visual_only') {
    return 'The visual track is ready, but timed dialogue is missing. Some story details may be harder to follow.';
  }
  if (mode === 'dialogue_only') {
    return 'Timed dialogue is ready, but the visual track is missing. Some actions and scene details may be left out.';
  }
  if (mode !== 'complete') return 'Some viewing material is still missing. The screening will have a lighter film feed.';
  return null;
}
