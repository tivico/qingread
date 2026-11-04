// Timing policy shared by the subtitle controller and deterministic Node tests.
(function (root) {
  const TIMING = Object.freeze({ settle: 650, maxWait: 2000 });
  const normalize = text => String(text || '').replace(/\s+/gu, ' ').trim();
  function continues(previous, current) {
    if (current.startsWith(previous)) return true;
    const words = previous.split(' ');
    for (let start = 1; start <= words.length - 3; start++) {
      const suffix = words.slice(start).join(' ');
      if (current === suffix || current.startsWith(suffix + ' ')) return true;
    }
    return false;
  }

  function createCueBuffer({adaptive = false} = {}) {
    let pending = null, submitted = null;
    return {
      observe(cue, now) {
        const text = normalize(cue?.text);
        if (!text) { pending = null; return; }
        const timelineVersion = cue.timelineVersion ?? 0;
        const key = `${timelineVersion}:${cue.version}`;
        if (pending?.key === key && pending.text === text) return;
        // Rolling the first line out is still the same continuous caption stream.
        // Resetting firstSeen here can starve translation indefinitely.
        const growing = pending && pending.key !== submitted && pending.timelineVersion === timelineVersion && continues(pending.text, text);
        pending = { text, version: cue.version, timelineVersion, key,
          firstSeen: growing ? pending.firstSeen : now, changedAt: now };
      },
      take(now, translationMs = 0) {
        if (!pending || pending.key === submitted) return null;
        const complete = /[。！？.!?][)"'’”」』]*$/u.test(pending.text);
        const short = pending.text.length <= 60;
        const settle = adaptive ? (complete ? 250 : short ? 350 : TIMING.settle) : TIMING.settle;
        const maxWait = adaptive ? (translationMs >= 1000 ? 1000 : 1500) : TIMING.maxWait;
        if (now - pending.changedAt < settle && now - pending.firstSeen < maxWait) return null;
        submitted = pending.key;
        return { text: pending.text, version: pending.version, timelineVersion: pending.timelineVersion,
          ...(adaptive ? {waitMs:now-pending.firstSeen} : {}) };
      }
    };
  }
  root.QingReadCaptions = Object.freeze({ TIMING, normalize, createCueBuffer });
  if (typeof module !== 'undefined') module.exports = root.QingReadCaptions;
})(globalThis);
