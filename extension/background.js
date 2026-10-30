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
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.type !== 'qingread:capture' || sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('panel.html')) return;
  (async () => {
    const [active] = await chrome.tabs.query({active:true,currentWindow:true});
    if (active?.id !== message.tabId) throw new Error('tab');
    const streamId = await chrome.tabCapture.getMediaStreamId({targetTabId:active.id});
    reply({streamId});
  })().catch(() => reply({error:'無法擷取此分頁音訊，請重新點外掛圖示並開始。'}));
  return true;
});
