class QingReadAudio extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(sampleRate * 4); this.used = 0; }
  process(inputs) {
    const channels = inputs[0]; if (!channels?.length) return true;
    for (let i=0; i<channels[0].length; i++) {
      let sample = 0; for (const channel of channels) sample += channel[i] || 0;
      this.buffer[this.used++] = sample/channels.length;
      if (this.used === this.buffer.length) {
        const out = new Float32Array(64000), ratio = sampleRate/16000;
        // Average source samples to avoid dropping all high-rate samples blindly.
        for (let j=0;j<out.length;j++) {
          const start = Math.floor(j*ratio), end = Math.max(start+1,Math.floor((j+1)*ratio));
          let sum=0; for(let k=start;k<end;k++) sum+=this.buffer[k]; out[j]=sum/(end-start);
        }
        this.port.postMessage(out,[out.buffer]); this.used=0;
      }
    }
    return true;
  }
}
registerProcessor('qingread-audio',QingReadAudio);
