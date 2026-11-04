'use strict';
(() => {
  const url=chrome.runtime.getURL('video-offscreen.html');
  let creating, closing;
  let lifecycle=Promise.resolve();
  function exclusive(action){const result=lifecycle.then(action);lifecycle=result.catch(()=>{});return result;}
  const exists=async()=>Boolean((await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[url]})).length);
  async function ensure(){
    if(closing)await closing;
    if(await exists())return;
    if(!creating)creating=chrome.offscreen.createDocument({url:'video-offscreen.html',reasons:['WORKERS','USER_MEDIA'],justification:'以背景 worker 處理影片字幕節奏，並在語音模式維持使用者啟動的分頁音訊擷取。'}).finally(()=>{creating=null;});
    await creating;
  }
  const call=(action,data={})=>chrome.runtime.sendMessage({type:'qingread:video-offscreen',action,...data});
  async function current(){return await exists()?call('status'):{active:false};}
  function trusted(sender,page){return sender.id===chrome.runtime.id&&sender.url===chrome.runtime.getURL(page);}
  const validTarget=t=>t&&Number.isInteger(t.tabId)&&Number.isInteger(t.windowId)&&typeof t.documentId==='string'&&t.documentId.length<128;
  const validConfig=c=>c&&['local','chrome'].includes(c.engine)&&['captions','speech'].includes(c.mode)&&['en','ja','ko','de','fr','es'].includes(c.source)&&Array.isArray(c.glossary)&&c.glossary.length<=100&&c.glossary.every(r=>Array.isArray(r)&&r.length===2&&r.every(t=>typeof t==='string'&&t.length<=80));
  chrome.runtime.onMessage.addListener((message,sender,reply)=>{
    if(!['qingread:video-control','qingread:video-host','qingread:video-stop-overlay'].includes(message.type))return;
    void (async()=>{
      if(message.type==='qingread:video-control'){
        if(!trusted(sender,'panel.html'))throw new Error('不允許此字幕控制來源。');
        if(message.action==='prepare'){
          if(!validTarget(message.target)||!validConfig(message.config)||typeof message.ticket!=='string')throw new Error('字幕設定不完整，請重新開始。');
          const [tab]=await chrome.tabs.query({active:true,windowId:message.target.windowId});
          if(tab?.id!==message.target.tabId)throw new Error('來源分頁已變更，請回到影片後再收合。');
          return exclusive(async()=>{await ensure();return call('prepare',{config:message.config,target:message.target,ticket:message.ticket});});
        }
        if(message.action==='status')return current();
        if(message.action==='collapse'){
          const state=await current();
          if(!state.active)throw new Error('背景字幕尚未接手，側欄保持開啟。');
          if(!chrome.sidePanel.close)return {manual:true};
          await chrome.sidePanel.close({windowId:state.target.windowId});return {closed:true};
        }
        if(['commit','cancel-prepare','stop'].includes(message.action)){
          if(!await exists())return {active:false,error:message.action==='commit'?'背景工作已結束，請重新開始字幕。':undefined};
          return call(message.action,{ticket:message.ticket});
        }
        throw new Error('不支援此字幕操作。');
      }
      if(message.type==='qingread:video-stop-overlay'){
        const state=await current();
        if(sender.id!==chrome.runtime.id||sender.tab?.id!==state.target?.tabId||sender.documentId!==state.target?.documentId||message.session!==state.id)throw new Error('字幕來源已變更。');
        return call('stop');
      }
      if(!trusted(sender,'video-offscreen.html'))throw new Error('不允許此背景請求來源。');
      if(message.action==='token')return {token:await QingReadLocal.savedToken()};
      if(message.action==='media'){
        if(!validTarget(message.target)||!['qingread:media-start','qingread:media-read','qingread:media-show','qingread:media-stop'].includes(message.message?.type))throw new Error('不支援此影片請求。');
        return chrome.tabs.sendMessage(message.target.tabId,message.message,{documentId:message.target.documentId});
      }
      if(message.action==='capture'){
        if(!validTarget(message.target))throw new Error('來源分頁不正確。');
        return captureTabAudio({...message.target,waitForRelease:true});
      }
      if(message.action==='idle'){
        setTimeout(()=>{void exclusive(async()=>{
          const state=await current();
          if(!state.active&&!state.preparing&&await exists()){
            closing=chrome.offscreen.closeDocument();await closing;closing=null;
          }
        }).catch(()=>{closing=null;});},4000);
        return {ok:true};
      }
      throw new Error('不支援此背景請求。');
    })().then(reply,error=>reply({error:error.message}));return true;
  });
  const event=data=>{void exists().then(found=>found&&call('event',data)).catch(()=>{});};
  chrome.tabs.onActivated.addListener(info=>event({kind:'activated',...info}));
  chrome.tabs.onUpdated.addListener((tabId,change)=>{if(change.status==='loading'||change.url)event({kind:'updated',tabId});});
  chrome.tabs.onRemoved.addListener(tabId=>event({kind:'removed',tabId}));
})();
