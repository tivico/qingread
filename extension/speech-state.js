(function(root){
  const POLICY=Object.freeze({windowMs:4500,strideMs:4000,overlapMs:500,maxQueueAgeMs:6000,maxResultAgeMs:15000});
  function createLatestBuffer(){
    let pending=null,dropped=0;
    return {
      offer(frame){if(pending)dropped++;pending=frame;},
      take(now){const frame=pending;pending=null;if(frame&&now-frame.capturedAt>POLICY.maxQueueAgeMs){dropped++;return null;}return frame;},
      clear(){pending=null;},
      get dropped(){return dropped;},get pending(){return Boolean(pending);}
    };
  }
  function trimOverlap(previous,text,{contiguous=false,overlapMs=0,segments=[]}={}){
    if(!contiguous||!previous||overlapMs<=0||!segments.length||segments[0].start>overlapMs/1000)return text;
    // Conservative word overlap only; no fuzzy matching or unrestricted replacement.
    const before=previous.trim().split(/\s+/u),after=text.trim().split(/\s+/u);
    const word=value=>value.toLowerCase().replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu,'');
    for(let count=Math.min(12,before.length,after.length);count>=3;count--){
      if(before.slice(-count).every((value,index)=>word(value)&&word(value)===word(after[index])))return after.slice(count).join(' ');
    }
    return text;
  }
  root.QingReadSpeech=Object.freeze({POLICY,createLatestBuffer,trimOverlap});
  if(typeof module!=='undefined')module.exports=root.QingReadSpeech;
})(globalThis);
