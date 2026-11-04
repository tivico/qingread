// Use an explicit toolbar action: the browser grants activeTab on this gesture.
function configurePanel() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
}
chrome.runtime.onInstalled.addListener(configurePanel);
chrome.runtime.onStartup.addListener(configurePanel);
configurePanel();
chrome.action.onClicked.addListener(tab => {
  // Invoke directly before any await, preserving the browser's user gesture.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {
    console.warn('QingRead: could not open side panel from toolbar action.');
  });
});
async function captureTabAudio(target) {
  const failure = (code, message) => Object.assign(new Error(message), {code});
  if (!Number.isInteger(target.tabId) || !Number.isInteger(target.windowId))
    throw failure('CAPTURE_TARGET', '影片來源已失效，請回到影片分頁重新開始。');
  const checkSource=async()=>{
    const [active] = await chrome.tabs.query({active:true,windowId:target.windowId}).catch(() => {
      throw failure('CAPTURE_TARGET', '影片視窗已關閉，請回到影片分頁重新開始。');
    });
    if (active?.id !== target.tabId)
      throw failure('CAPTURE_TARGET', '來源分頁已變更，請回到原影片分頁再開始。');
  };
  await checkSource();
  if (!await chrome.permissions.contains({permissions:['tabCapture']}))
    throw failure('CAPTURE_PERMISSION', '尚未允許分頁音訊權限，請重新開始並允許權限。');
  // Chrome releases stopped tracks asynchronously. Only handoff/recovery waits;
  // an ordinary start must still report another active capture immediately.
  if(target.waitForRelease===true){
    const deadline=Date.now()+2000;
    while((await chrome.tabCapture.getCapturedTabs()).some(tab=>tab.tabId===target.tabId&&['active','pending'].includes(tab.status))){
      if(Date.now()>=deadline)throw failure('CAPTURE_BUSY','原音訊擷取尚未釋放，請稍後重新開始字幕。');
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    await checkSource();
  }
  try {
    return {streamId:await chrome.tabCapture.getMediaStreamId({targetTabId:target.tabId})};
  } catch (error) {
    const detail = String(error?.message || error);
    const busy = /active stream|already (?:being )?captur|in use/i.test(detail);
    const invoked = /not been invoked|activeTab|permission|cannot access/i.test(detail);
    const code = busy ? 'CAPTURE_BUSY' : invoked ? 'CAPTURE_INVOKE' : 'CAPTURE_FAILED';
    console.warn('QingRead tab capture:', code, detail);
    throw failure(code, busy
      ? '此分頁已有音訊擷取工作，請先停止其他擷取，再重新開始。'
      : invoked ? '請回到影片分頁，點 Chrome 工具列的清讀圖示，再按開始字幕。'
      : 'Chrome 無法啟動此分頁音訊。請重新整理影片、點工具列清讀圖示後重試。');
  }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.type !== 'qingread:capture' || sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('panel.html')) return;
  captureTabAudio(message).then(reply, error => reply({error:error.message,code:error.code || 'CAPTURE_FAILED'}));
  return true;
});

importScripts('local-client.js', 'video-background.js');
