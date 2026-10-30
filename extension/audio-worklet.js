class QingReadAudio extends AudioWorkletProcessor {
  constructor() {
    super();this.buffer = new Float32Array(sampleRate * 4.5);this.overlap=Math.round(sampleRate*.5);this.used=0;this.sequence=0;this.epoch=0;
    this.port.onmessage=event=>{if(event.data?.type==='reset'){this.buffer.fill(0);this.used=0;this.sequence=0;this.epoch=event.data.epoch??this.epoch+1;}};
  }
  process(inputs) {
    const channels = inputs[0]; if (!channels?.length) return true;
    for (let i=0; i<channels[0].length; i++) {
      let sample = 0; for (const channel of channels) sample += channel[i] || 0;
      this.buffer[this.used++] = sample/channels.length;
      if (this.used === this.buffer.length) {
        const out = new Float32Array(72000), ratio = sampleRate/16000;
        // Average source samples to avoid dropping all high-rate samples blindly.
        for (let j=0;j<out.length;j++) {
          const start = Math.floor(j*ratio), end = Math.max(start+1,Math.floor((j+1)*ratio));
          let sum=0; for(let k=start;k<end;k++) sum+=this.buffer[k]; out[j]=sum/(end-start);
        }
        this.port.postMessage({samples:out,sequence:this.sequence++,epoch:this.epoch,durationMs:4500,overlapMs:this.sequence===1?0:500},[out.buffer]);
        this.buffer.copyWithin(0,this.buffer.length-this.overlap);this.used=this.overlap;
      }
    }
    return true;
  }
}
registerProcessor('qingread-audio',QingReadAudio);
