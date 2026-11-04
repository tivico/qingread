# 優化進度與維護紀錄

更新日期：2026-11-04。這份文件追蹤使用者提出的六項優化；每次工作結束都更新狀態與證據，不能只以測試通過宣告整個專案完成。

| 項目 | 狀態 | 已完成範圍／待辦 |
| --- | --- | --- |
| 1. 等待與取消 | 本機互動工作已實作並實測 | 互動工作使用 180 秒預算與取消清理確認。字幕另有自適應等待及本機耗時拆解。PDF 相容端點及 Whisper 辨識使用既有生命週期。 |
| 2. 重複翻譯快取 | 本機互動工作已實作並實測 | 指令、原文、來源語言、模型內容指紋及推論設定一致才重用；容量、bytes 與 TTL 有限。PDF 舊端點尚未套用。 |
| 3. 翻譯逐段顯示 | 已實作 | 已完成段落立即顯示；中斷保留部分並可接續；原文、設定及本機模型身分改變時禁止接續。 |
| 4. 長網頁擷取 | 已實作並量測 | 每 512 個文字節點讓出執行時間。忽略正文範圍以外的變動，來源變動時只重取一次，取消立即放棄該次結果。 |
| 5. 語音字幕 | 已實作並分階段量測 | 4.5 秒視窗／4 秒步距、0.5 秒重疊、保守去重、最多最新一段緩衝與過期略過。原生音訊與背景工作已用人工內容連續驗證三十分鐘；真實網站端到端、多語辨識與譯文品質仍待驗收。 |
| 6. PDF 操作體驗 | 已實作並以人工文件實測 | 回報分析／OCR／翻譯／輸出與取消狀態。試翻最多兩頁。工作準備或啟動失敗會釋放名額，複雜文件品質仍需逐份核對。 |

六項清單已有實作，但使用者持續遇到錯誤，目前轉入穩定性修復，不以實作完成或測試數量代表產品可用性驗收完成。互動工作取消不等於 PDF 相容端點或 Whisper 的模型運算可立即停止，範圍與限制見各節。

## GitHub 原始碼發佈（2026-11-04）

使用者指定 `https://github.com/tivico/qingread.git` 並授權發佈，目前以 `main` 維護，遠端名稱使用 `origin`。本次上傳原始碼、測試與文件，不建立 GitHub Release，也不把本機安裝 ZIP、模型、.venv、companion/data 或個人文件加入 Git。README 補上取得原始碼與安裝入口，INSTALL 說明原始碼解壓後可直接使用既有 companion／extension 配置。

發佈流程為檢查工作目錄及歷史的檔案範圍／憑證特徵 → 提交目前 0.3.9 修復 → 設定 origin → 推送 main → 比對本機 HEAD 與遠端 main 的提交識別。若遠端已有其他提交，先讀取並整合，不以 force push 覆蓋。推送失敗先看登入／儲存庫寫入權限與遠端是否有新提交，不把憑證寫入網址或程式碼。

後續修改先看 `git status` 與差異，執行必要測試後明確加入原始碼、提交並 `git push`。例如新增外掛功能時，只加入對應 extension／tests／文件；維持 .gitignore 排除規則，勿用 `git add -f` 上傳 data 或發行包。發行包的產生方式仍見下一節；需要之後提供 GitHub Release 時另行上傳已驗證的套件。

## 0.3.9 Windows 親友安裝包（2026-11-04）

**範圍與版本。** 使用者選擇自己／親友安裝包。本批將外掛 manifest、package.json、助手 VERSION、側欄、工作室與診斷字樣同步為 0.3.9；整合先前修復，供 Windows 本機安裝使用。沒有自動停止或替換使用者正在執行的助手，也沒有上傳外部服務。原生音訊三十分鐘驗證使用人工內容，真實網站及模型品質的邊界維持前節記錄。

**打包問題與設計。** 舊 `scripts/package.ps1` 未納入 CHANGELOG 與 docs，完整包的維護連結失效；遞迴複製 tests 可能帶入 Python bytecode，且每次留下暫存目錄。新流程明列產品模組與授權檔，測試只取根目錄原始碼及固定 fixtures 目錄的指定類型。未知外掛／助手檔案不會自動入包，新增模組時要維護清單。模型、.venv、companion/data、個人輸入輸出、錄音、瀏覽器設定檔與測試結果皆不複製。

**建置流程。** 執行 `pwsh -NoProfile -File scripts/package.ps1`（也可用 Windows PowerShell）→ 檢查三處版本一致 → 複製明列檔案到本次獨立的 `build/package-<ID>` → 產生根目錄直接放 manifest 的 `qingread-0.3.9.zip`，以及保留 extension／companion 等目錄的 `qingread-complete-0.3.9.zip` → 依 ZIP 實際位元組產生 `qingread-0.3.9-SHA256SUMS.txt` 與 `qingread-0.3.9-release.json` → 驗證暫存路徑是 build 的直接子目錄才移除。舊發行包及其他 build 目錄不刪除，正式資料不參與建置。

**安裝與回復。** 親友解壓完整包到固定位置，按 `extension/INSTALL.txt` 準備助手、載入 extension、各自連接配對及下載所需資源。已有安裝者先停止工作並保留自己的 data／.venv，以新版程式更新原位置、在原 Chrome 項目重新載入，重啟助手後核對 0.3.9。不要轉交自己的 data 或整個開發資料夾。異常時先查套件版本、載入路徑與助手實際版本，再以舊版程式同步回復外掛及助手，保留個人資料；不要刪 data 來處理版本不一致。

**維護與診斷。** `tests/test_package.py` 在隔離來源樹放入假配對設定、環境、bytecode 與文件，驗證不被入包、來源位元組相同、必要文件存在、版本不一致先拒絕及校驗資訊正確。打包失敗先看缺少的明列檔案與版本，再看檔案是否被占用；不要發送未完成的 ZIP。成品缺模組時先查 `$extensionFiles/$companionFiles`，例如新增 `example.js` 應加入清單並重新跑打包測試，最後從成品解壓副本跑原生 Chrome 載入，而不只測工作目錄。驗證成品用 `QINGREAD_EXTENSION_PATH` 指定 `tests/extension-smoke.cjs` 的來源目錄；不修改正式外掛。正式助手未做新功能修改，只同步版本。

**驗證紀錄。** 0.3.9 通過 70 項 JavaScript 與 58 項 Python（包含兩項隔離打包測試）。實際發行 ZIP 檢查通過：外掛包 27 個檔案、完整包 84 個檔案，所有入包內容逐位元比對工作目錄相同，SHA-256 與發行 JSON 一致，沒有模型、環境、配對及個人資料目錄。由完整 ZIP 解壓副本啟動的隔離助手回報 0.3.9，工作、固定識別、影片推論與 PDF 試翻能力均存在；同一副本的外掛在真實 Chromium 載入，通過原生權限拒絕、工具列授權、正文擷取及純譯文切換。

可用 `companion/.venv/Scripts/python.exe tests/verify_release.py --native` 重驗實際成品；工具讀取發行資訊、查驗兩個 ZIP 的雜湊／來源位元組、以測試資料啟動包內助手，並將解壓後的外掛交給原生 Chrome 測試。報告是 `test-results/release-verification.json` 及 `extension-smoke.json`，不使用正式助手或其配對資料。實際打包使用 PowerShell 7；本機 Windows PowerShell 執行腳本被 AuthorizationManager 阻擋，沒有改安全政策，也未將它標記為已執行驗收。

功能的前輪證據另有 137 項完整 Chromium、語言包取消補測與三十分鐘人工音訊連續測試。本輪未在另一台全新 Windows 電腦從零安裝依賴或下載模型，因此親友第一次安裝仍需依 INSTALL 先完成三項初驗。這些是本機安裝套件，尚未上傳商店或建立自動更新服務。

## 語音啟停、忙碌重試與交接恢復（2026-11-04）

**修復前後。** 三項檢查發現中，已用人工控制時序重現：側欄等待 `AudioContext.resume()` 時按停止，音軌已停止，但晚到的結果仍將狀態改回聆聽中並啟用收合；以及 `/speech` 回覆 `SPEECH_BUSY`／429 時，字幕立即停止。另由程式確認語音交接先銷毀側欄工作，背景取得音訊失敗時沒有恢復路徑。新版在每個音訊啟動等待點檢查工作是否仍有效，忙碌改為有限等候，交接保留翻譯器並在安全條件成立時恢復側欄。

**檔案與取捨。** `video.js/newSession()` 建立全新工作識別及取消控制器，`startSpeech()` 共用音訊啟動，`releaseAudio()` 釋放音軌與 AudioContext。語音收合時先停止原管線及音訊，保留翻譯器到提交結果確定；恢復時沿用原引擎、來源語言、詞彙表及雙語設定，建立新工作，避免舊回應回填。Chrome 語言包的翻譯器也因此不必在失敗後重新要求使用者手勢。成功才銷毀原翻譯器，失敗且交回側欄時由恢復後的工作接管清理。

取消控制器是通知非同步工作停止的開關，模型與單筆請求要用不同開關。依 [AI 模型建立與銷毀規範](https://webmachinelearning.github.io/writing-assistance-apis/)，取消傳給 `Translator.create()` 的訊號，也會銷毀已建立的模型；因此 `engineController` 專門供模型建立使用，`controller` 只取消管線／單筆翻譯。交接保留前者，恢復工作也接管前者；停止尚未建立完成的引擎會中止建立，已建立的引擎由 `destroy()` 釋放。測試替身同步模擬此語意，確認恢復後翻譯仍能成功；本機已下載 Chrome 語言包的實際背景可用性仍未驗收。

`video-pipeline.js/drainSpeech()` 只對明確的 `SPEECH_BUSY` 且 HTTP 429 重試；`speech-state.js/POLICY` 的 `busyRetryMs=500`、`busyTimeoutMs=10000` 控制最短重試間隔與連續忙碌等待上限。使用既有 `watchSpeech()` 節奏檢查重試，不新增常駐重試計時器。新片段到達就取代舊候選，既有六秒排隊／十五秒結果過期規則仍有效；超過忙碌預算明確停止，其他錯誤不重試。正常辨識已被助手接受後的處理耗時不屬於 busy 等候預算。這沒有讓 Whisper 支援模型級即時取消：前一筆中止 HTTP 後，CPU 上的辨識可能仍在收尾，因此新工作可能短暫 busy。

**交接資料流。**

1. `video.js` 用原工作 ID 當穩定 `ticket`，送 `video-control/prepare`，原字幕繼續。
2. 準備完成後，語音工作中止舊請求、清掉音訊候選並釋放音軌；保留翻譯器，進入 suspended 狀態。這段時間 `session` 為空，但仍以 `handoff.source` 追蹤原分頁及視窗。
3. 送 `commit`，`video-background.js` 轉送 `video-offscreen.js` 接管。背景擷取與側欄恢復都帶 `waitForRelease`，由 `background.js/captureTabAudio()` 最多等待兩秒，直到 Chrome 不再將來源列為 active／pending，再重新核對來源分頁。普通開始不等待，不會主動關閉其他擷取。
4. 提交成功則釋放原翻譯器並收合。提交失敗時先送原 `ticket` 的 `cancel-prepare`；必須收到 `active:false` 的明確回覆，才可恢復。若有其他背景工作仍 active，交回背景控制；回覆遺失則提示查看狀態，不擅自重取音訊。
5. 驗證來源的 `tabId/windowId/documentId` 相同，再以原翻譯器及新工作 ID 重啟側欄。若使用者已停止、換頁、關閉側欄或開始其他功能，就取消恢復；回復本身失敗時顯示原因並保留手動重新開始。

因 Chrome 同一分頁不能同時持有兩個音訊擷取，這次採釋放後重取，不保證語音字幕無縫。交接與恢復會捨棄尚未處理的片段，重新收集約 4.5 秒音訊後才有下一筆字幕。現有字幕模式仍保留先前的原頁擁有者交接，不改成音訊重取。

**重現與除錯。** 重載外掛、重開側欄、刷新影片後再點工具列。先以語音模式開始後立即停止，等幾秒，確認仍是停止且收合不可按；若狀態反跳，檢查 `startSpeech()` 的 `live(s)`。若出現忙碌等候，看 `/speech` 是否確實是 `error:SPEECH_BUSY/status:429`，不要把 401 配對或連線錯誤當成 busy；超過等待上限時先讓前筆收尾再重啟，持續不恢復才檢查助手。收合失敗時看 `video-background-status` 是否顯示「已恢復側欄」，保持側欄開啟並等新片段；若提示無法確認背景，重新打開控制頁查看背景狀態，先停止背景再重試。音訊重取失敗仍依前節的 `CAPTURE_*` 排查。

**自行修改例。** 想將忙碌容忍改為十五秒，修改 `speech-state.js/POLICY.busyTimeoutMs` 為 15000，保留最短重試間隔與最新片段／過期規則，並更新說明。重跑 `npm.cmd test` 應驗證有限次重試、新片段取代、停止與快轉不重播舊音訊，不能只看字幕最後有出現。改交接流程時，至少測成功、背景失敗可恢復、恢復本身失敗、使用者停止／換頁取消、取消回覆遺失不擷取，以及原翻譯器只銷毀一次。

**驗證。** 70 項 JavaScript 已通過，包含 busy 最短間隔、最新片段、上限停止、停止／快轉清除、其他錯誤不重試，以及音訊釋放有期限與來源再驗證。137 項完整 Chromium 回歸通過；其後補上符合原生語意的模型取消替身，再通過十一項相關測試，覆蓋停止時音訊仍在恢復、失敗後繼續辨識／翻譯、交接中停止／換頁／改做文字翻譯、恢復失敗及缺少背景取消確認。

三十分鐘原生音訊／背景連續測試已通過。實際經過 1,800,023 毫秒，180 次取樣都維持一個 active 音訊擷取與一個 offscreen 背景頁，每次讀到的雙語字幕都與前一次不同。結束後重開控制頁確認背景狀態，從影片內按停止，字幕與控制按鈕移除，音訊釋放，閒置背景頁關閉；隔離測試設定檔已清理。這驗證本輪音訊與交接流程長時間執行，沒有量測程序記憶體曲線，也不代表真實網站的辨識或譯文品質通過。

`tests/capture-smoke.cjs` 已用真實 Chrome 串流驗證停止音軌後，直接使用產品的釋放等待即可重啟。新增 `tests/speech-handoff-smoke.cjs`：隔離設定檔、人工播放中影片及音訊、本機暫時助手，首筆語音回 busy，之後回人工逐段文字；模型翻譯使用人工回應。短程已通過 busy 恢復、刻意使背景擷取失敗後恢復側欄、再次成功收合、控制頁銷毀後全螢幕持續字幕、影片內停止以及音訊／背景頁清理。

既有 `tests/background-video-smoke.cjs` 另以人工模型回應通過現有字幕的原生交接、控制頁關閉、容器全螢幕、重開狀態及耗時、影片內停止與閒置釋放；本輪報告 `liveModel:false`，不沿用前輪真正 Ollama 的驗證標籤。正式助手程式本輪未修改，未重跑 Python 全套，也未額外下載 Chrome 語言包或模型。

重測需設定 `CHROME_PATH` 後執行 `node tests/speech-handoff-smoke.cjs`；加 `--soak-minutes 30` 做真正經過三十分鐘的連續測試，每十秒查字幕更新、恰好一個 active 擷取及一個 offscreen 背景頁。報告為 `test-results/speech-handoff-smoke.json`。測試會自建及清理隔離設定檔和助手，不讀私人分頁、不用正式助手，也不呼叫真實 Whisper／Ollama；權限在測試副本預先授予，原生權限視窗、真實網站、多語辨識及譯文品質仍需驗收。本批僅修改外掛與測試，正式助手程式沒有新增修改；若前幾批助手尚未啟用，仍須另依其章節重啟。

## 語音字幕擷取與使用說明（2026-11-04）

**問題與證據。** 使用者回報「無法擷取此分頁音訊，請重新點外掛圖示並開始。助手已確認該筆工作結束。」前半句原本涵蓋所有擷取失敗，無法從舊訊息判定確切根因。程式確認側欄擷取使用 `currentWindow`，多視窗時可能與已綁定的來源視窗不同；此外 `cancellationText([])` 的空集合判斷會誤報尚未建立的工作已確認結束。本批修正這兩處，並補上原生錯誤分類。這不代表已確定使用者當時是多視窗或未叫用工具列。

**操作與資料流。** 兩種字幕來源二選一，原文語言選來源字幕／實際說話語言，「同時顯示原文」在開始前設定。現有字幕模式讀播放器 CC，不需要擷取聲音。語音模式先在工作室配對、準備語音模型，回影片分頁點 Chrome 工具列圖示後再開始，允許分頁音訊權限。`video.js` 綁定影片文件並將 `tabId/windowId` 傳入 `qingread:capture`；`background.js/captureTabAudio()` 驗證來源視窗啟用分頁與可選 `tabCapture` 權限，向 Chrome 取得串流識別。側欄用 `getUserMedia()` 取得串流、`AudioContext` 保持聲音播放，`audio-worklet.js` 以四秒步距送音訊至 `POST /speech`，Whisper 文字交給所選翻譯引擎，最後疊加原文與繁中。背景交接的 `video-background.js` 也使用相同擷取函式。至少先收集一段音訊，再加辨識和翻譯延遲。

**診斷順序。** 先重載外掛、重開側欄、刷新影片，再點工具列清讀圖示並開始，確認影片分頁仍啟用。`CAPTURE_TARGET` 表示來源／視窗失效或已切頁；`CAPTURE_PERMISSION` 表示可選音訊權限尚未授予；`CAPTURE_INVOKE` 是已知未叫用／存取權錯誤，回影片點工具列再試；`CAPTURE_BUSY` 先停止其他音訊擷取；`CAPTURE_FAILED` 是未分類的 Chrome 錯誤。若仍失敗，到 `chrome://extensions` 的清讀項目開服務工作者主控台，查 `QingRead tab capture:` 後的代碼和 Chrome 原因，再決定擴充分類。原生錯誤僅記在本機主控台，不送模型。網頁讀取成功不代表有音訊擷取資格。助手結束訊息只表示取消／清理確認，不能作為辨識成功證據；現在沒有待清理工作時省略該訊息。停止或刷新影片可釋放目前串流，再回影片點圖示重試。

**自行維護。** 想為新的 Chrome 錯誤增加提示，在 `captureTabAudio()` 的原生錯誤分支增加明確匹配，未知原因維持通用失敗，避免把所有錯誤都推定為權限問題。例如 Chrome 改了「已有串流」的英文文字，先用主控台取得新字句，在 `tests/video-background.test.cjs` 加入該字句，確認分類為 `CAPTURE_BUSY` 再改匹配。不要移除來源視窗與啟用分頁核對，也不要為方便而把正式版 `tabCapture` 改成預設必要權限。想改雙語呈現，入口在 `video.js` 的 `bilingual`，頁面和背景設定需一起驗證；來源選擇與翻譯引擎是獨立概念。

**已驗證與限制。** `npm.cmd test` 的 65 項 JavaScript 通過；`node --test --test-name-pattern 'speech|stopping video|video reports real permission' tests/browser.test.cjs` 的五項 Chromium 回歸通過。新增捕捉失敗後復原按鈕、帶來源視窗以及不顯示虛假助手確認的驗證。`tests/capture-smoke.cjs` 以隔離 Chromium 與人工 440 Hz 音訊測試真實原生擷取：未點工具列被拒絕且分類正確；點擊後服務工作者取得串流識別、外掛頁能消費且取到非零訊號；重複擷取回 busy；停止後可重新取得串流。報告在 `test-results/capture-smoke.json`。測試必須取消 Playwright 預設的 `--mute-audio`，否則只能取得零訊號，這是測試設定，沒有修改使用者瀏覽器靜音狀態。測試副本將音訊權限預先授予，不涵蓋真實可選權限視窗、使用者當時的環境或真實影片的 Whisper／翻譯品質；本批沒有修改助手。

重測原生擷取可先將 `CHROME_PATH` 設為已安裝的測試 Chromium，再執行 `node tests/capture-smoke.cjs`。工具僅開啟隔離設定檔與人工測試分頁，不讀私人分頁，不啟動助手；結果寫入後清掉自己建立的暫時設定檔。本批啟用需重載外掛、重開側欄、刷新來源並重新點工具列圖示；若先前的助手更新還沒啟用，仍須依其章節另行重啟助手。

## 影片自適應送翻、耗時與推論設定（2026-11-04）

**行為與取捨。** 原本現有字幕固定等待穩定 650 毫秒、持續補字最多等兩秒。新版側欄和背景啟用 `createCueBuffer({adaptive:true})`，句尾完整時穩定 250 毫秒可送出，六十字元內的短句為 350 毫秒，其他維持 650 毫秒。持續補字通常最多等 1.5 秒，近期平均翻譯超過一秒則縮至一秒。這是標點和長度的判斷，縮短等待可能讓尚未說完的片段較早翻譯。仍維持單筆翻譯、最新候選和原本的閱讀停留與快轉規則。

**資料流。** `media-content.js` 讀原字幕，`caption-state.js` 記錄候選開始等候時間，`video-pipeline.js` 按近期耗時取出候選。本機翻譯器由 `video.js` 或 `video-offscreen.js` 建立，帶 `profile: video` 經 `local-client.js` 送至助手 `start_inference()`。助手將文字放在 JSON 的「原文」欄位，檢查模型與快取後生成譯文，回傳文字和 `timings`。客戶端保留字串回傳方式，額外把這筆耗時放在 `translator.lastMetrics`，共用字幕程式再把等待和往返時間合併。背景狀態包含最近耗時，重開側欄仍可展開「查看字幕耗時」。

**本機字幕設定。** `profile: video` 只接受翻譯工作。輸出上限依原文長度計算，最少 256、最多 4096 tokens，tokens 是模型使用的文字單位。保守估算輸入與輸出預算可放進 4096 時使用較小上下文，否則保留 8192。字幕指令要求翻譯明確的原文欄位，模型在閒置後保留十分鐘，會占用相應記憶體。快取識別包含完整推論設定，普通文字、網頁和字幕的結果分開。回報長度截斷仍視為失敗，縮小上限主要防止冗長輸出，實際加速須量測。

**耗時定義。** `waitMs` 是候選首次觀察到後等待送出的時間，`translationMs` 是前端翻譯到送回頁面的往返時間。助手的 `queueMs` 是工作建立至取得推論通道，`prepareMs` 包含模型身分與快取檢查。 `loadMs/promptMs/generationMs` 由 Ollama 最後一筆回應的奈秒資料換算，代表模型載入、讀取輸入及產生輸出。缺少的欄位不顯示為零，快取回應也不沿用上一筆模型耗時。這些分項包含於往返時間，不能再與往返時間相加。

**啟用與排查。** 等重要工作結束，關閉舊助手並重啟 `companion/start.cmd`，再重載外掛、重開側欄及刷新影片頁。 `/health.video_inference: true` 表示助手已載入字幕設定支援。若提示助手需更新，先核對正在執行的助手，不要只看檔案或同為 0.3.8 的版本號。展開「查看字幕耗時」後，排隊高先看是否有其他本機工作，載入高觀察後續暖機是否恢復，讀文高檢查字幕長度，生成高再比較已安裝模型。停止及重新開始可清空本次工作。

**自行修改例。** 想調整持續補字的等待上限，修改 `caption-state.js/take()`，並用相同時序比較首次顯示、顯示筆數及同時工作數，保留快轉與兩秒閱讀測試。要改字幕上下文或輸出預算，修改 `app.py/start_inference()` 的 video 分支，並一起驗證長輸入、截斷錯誤、一般翻譯與字幕快取隔離。可執行 `npm.cmd test`、設定 `CHROME_PATH` 後的 `npm.cmd run test:browser`，以及 `.\companion\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'`。

**量測結果。** 同一份匿名捲動字幕時序搭配固定 1.9 秒翻譯延遲，首次送翻由 2.25 秒提早至 1.75 秒，首次顯示由 4.2 秒提早至 3.7 秒，顯示更新由八筆增至九筆，同時仍只有一筆處理。報告為 `test-results/adaptive-caption-benchmark.json`，這是時序回播，不能當成完整句子覆蓋率。

真正 Gemma 3 4B 以三句人工短文比較，暖機後的一般設定中位數 1.625 秒、影片設定 1.672 秒，這次沒有量到穩定的模型端加速。影片設定的重複原文命中快取約 0.172 秒。第一次精簡指令曾讓其中一句回成「請提供原文」，已改為 JSON 原文欄位後重測，三句均有對應譯文。初次載入仍約五至六秒，模型保留設定主要減少短暫離開後重新載入的機會。這是單機單輪結果，譯文品質需逐句驗收。

量測工具是 `tests/benchmark_video.py --live`，用 `companion/.venv/Scripts/python.exe` 執行，使用目前選定模型與暫時助手。報告 `test-results/video-inference-benchmark.json` 保存耗時及人工譯文，初次發現錯答的報告另存為 `video-inference-benchmark-initial.json`。閱讀 JSON 可用 `Get-Content -Encoding utf8`。

**驗證。** 61 項 JavaScript、56 項 Python、131 項 Chromium 測試通過，涵蓋自適應首次送翻、單筆處理、舊助手能力阻擋、推論設定與快取隔離、長輸入與截斷，以及缺少耗時時的顯示。另以真正 Ollama、暫時助手與隔離外掛跑 `tests/background-video-smoke.cjs --live-model`，確認收合後繼續更新、重開控制頁能取得背景耗時、容器全螢幕、停止和背景釋放。影片是人工播放畫面，日常網站及語意品質仍需核對。

## 影片字幕大量略過與短暫延遲（2026-11-04）

使用者回報背景狀態顯示最近翻譯 1.9 秒、略過 7 段。程式確認略過數每次只在 `media-show.applied=false` 時加一，沒有重複累計同一筆完成回應。原本的判定要求譯文仍能對應當下原字幕，短句每秒換行時，即使翻譯只花 1.9 秒也可能持續被丟棄。此數字是完成回應的拒收次數，可能包含同句不同版本，不能直接當成漏掉的完整句數。

**資料流與取捨。** `video-pipeline.js/display()` 的現有字幕請求帶 `allowRecent`，`media-content.js/readCue()` 在有限的版本歷史中記錄原文最後仍出現的時間。 `canShow()` 先檢查目前字幕相符，若已換句，可接受最後出現時間距今最多 2.5 秒的已知原文。它必須在同一播放時間線，且不能比已顯示或等待中的譯文版本更舊。接受延遲會增加能顯示的回應比例，畫面同步標示「譯文稍有延遲」。過期後待處理結果會丟棄，已顯示內容在至少兩秒閱讀時間後清除。仍然只留最新候選字幕，處理能力不足時可能漏掉中間句。

**排查與自行修改。** 重載外掛並刷新影片頁，再觀察「已收到／已略過」比例及翻譯耗時。若已收到持續增加而畫面沒有更新，檢查 `media-read.display.pending` 與 `refreshDisplay()` 的閱讀停留時間。若略過持續增加，先看是否經常快轉、來源原字幕更新快於引擎，或工作版本已失效。要調整延遲上限，修改 `RECENT_CUE`，並一起測試近期結果可顯示、超時清除、快轉拒收及舊結果不能蓋過新結果。提高上限會增加畫面與語音落差，不能只看略過數下降。

**證據邊界。** 使用者提供 [這部 YouTube 影片](https://www.youtube.com/watch?v=F8jidmEkIeM)。獨立未登入 Chromium 可開啟頁面，但十八秒觀測未取得原字幕，無法據此量測該片實際換句頻率。既有兩份匿名 YouTube 時序以 1.9 秒模擬延遲，原規則沒有拒收，亦不能當成本次問題的重現。新增每秒換句的人工時序，在前 6.5 秒由原判定收到 0／拒收 2，改善為收到 2／拒收 0，兩筆均實際顯示。這是顯示政策驗證，未量測實際 Ollama 的翻譯品質或該片字幕覆蓋率。

**驗證。** 59 項 JavaScript、130 項 Chromium 測試通過。新增短暫延遲顯示與標示、過期清除、快轉失效及新版不能被較舊結果覆蓋，並保留收合交接、語音及既有閱讀停留測試。人工比較報告為 `test-results/rapid-caption-latency.json`，可用 `npm.cmd test` 及設定 `CHROME_PATH` 後的 `npm.cmd run test:browser` 重驗。

## 影片現有字幕收合交接修復（2026-11-04）

使用者以本機模型、讀取影片現有字幕，按「收合側欄，繼續字幕」後字幕消失。程式確認原流程在提交背景工作前先呼叫 `video.js/stop()`，該動作會發送 `media-stop` 移除字幕。接手時 `media-start` 又重設字幕框和時間線，造成交接空窗，背景提交失敗時也無原工作可繼續。另確認 `video-pipeline.js` 引用了其他函式範圍內的 `mediaError`，使讀取及模型錯誤的回報再次失敗。

**資料流。** 現有字幕從 `video.js` 送 `prepare` 到 `video-background.js`，由 `video-offscreen.js` 建好背景引擎。側欄繼續原工作，直到 `commit` 透過 `media-start` 的 `handoff` 欄位，在同一份來源文件驗證舊工作 ID、字幕模式及影片物件，才把 `media-content.js` 的擁有者換成新背景工作。字幕框、字幕版本及時間線保持連續。成功回覆後側欄才釋放計時器與模型，並收合介面。頁面會拒絕舊工作後來送出的清除或顯示請求。

**失敗與取消。** 準備或提交失敗會保留原側欄。若已接管頁面才發生提交錯誤，背景先透過相反方向的 `handoff` 交回原工作，再釋放自己的資源。交接取消用原工作 ID 核對背景的交接識別，避免晚到的提交繼續跑。 `QingReadVideoPipeline.errorText()` 統一提供側欄與背景的影片錯誤文字。語音模式仍需先釋放原音訊擷取，再由背景重新取得音訊，使用不同的資源交接順序。

**排查與維護。** 重載外掛、刷新影片頁、重開側欄，先等一筆譯文出現，再按收合。影片上的字幕框應留到下一句替換，重開側欄應顯示背景狀態。若沒有下一句，依序看 `video-background-status` 的交接錯誤、`video-status` 的模型或來源錯誤，再檢查助手是否可用及原生字幕是否持續更新。停止或重新整理影片可清掉本次工作。日後要調交接時機，須一併驗證成功保留字幕、提交失敗回復原工作及取消後沒有背景殘留。不要把「引擎建立成功」直接當成可以先停止原工作的依據。

**驗證。** 59 項 JavaScript、128 項 Chromium 測試通過。新增背景提交失敗後交回原工作、指定交接識別的取消、共用錯誤處理、頁面交接保留字幕版本與時間線，以及舊工作不能清除新字幕。 `node tests/background-video-smoke.cjs --live-model` 以真正 Ollama、隔離助手與外掛及人工播放中的影片驗證，收合時字幕框未被移除，控制頁銷毀後仍翻譯下一句。播放器容器全螢幕、重開控制、影片內停止及背景頁釋放也通過。報告為 `test-results/background-video-smoke.json`。使用者日常影片網站及實際語音交接仍需實機核對。

## Chrome 語言包中外文混合輸入（2026-11-04）

使用者貼上「權限只把 package 設成 Read」，語言包卻產生不相干的短句。程式確認 `text.js/translate()` 原本直接以共用設定的來源語言處理整個輸入，沒有保護其中已是中文的文字。Chrome Translator API 要求呼叫端提供正確的來源語言，來源未知時官方建議先做語言偵測。 [Chrome Translator API](https://developer.chrome.com/docs/ai/translator-api)

**資料流與取捨。** 現在文字翻譯選 Chrome 語言包且來源為英文、德文、法文或西班牙文時，`preservesChinese()` 先檢查輸入是否含漢字。原有長文分批流程會再把每批分成漢字與外文片段，中文片段保留，含外文字母的片段才送給既有翻譯器。每批完成後照原順序拼回，台灣用語與詞彙表只套用至翻好的外文。純中文直接回填原文。日文需要翻譯漢字，因此沿用整句翻譯。本機模型也仍取得整句，以使用上下文。

**排查與維護。** 重載外掛並重開側欄後，在文字翻譯頁確認輸入欄下方的引擎和語言提示。以回報句子重測時，中文應保留，實際交給語言包的內容應是 `package`、`Read`。若中文仍被改寫，先確認提示顯示中文保留模式，再檢查 `text.js` 是否已載入新版。若只有外文譯詞不合上下文，先查原詞是否為程式或權限名稱，可手動改用本機模型翻整句。分段翻譯會減少上下文，這批修正保護既有中文，外文詞義仍須由使用者核對。

**自行修改例。** 若要擴充中文保留模式支援的來源語言，修改 `preservesChinese()` 的語言清單，再測含漢字的目標語言句子。日文的漢字和中文共用字形，因此不能只依「有漢字」就保留。可用 `npm.cmd test`，以及設定 `CHROME_PATH` 後執行 `node --test --test-name-pattern 'pasted text|text tab|text translation|partial text|local text|Chinese preservation' tests/browser.test.cjs`。

**驗證。** 56 項 JavaScript 和 15 項文字相關 Chromium 測試通過。回報句只送出 `package` 與 `Read`，並以固定譯文驗證中文原位保留。另涵蓋純中文長文與換行、日文、本機模型、取消及接續翻譯。隔離 Chrome 只查詢了語言包可用狀態，實際外文譯詞品質尚待使用者目前的語言包驗收。

## 網頁翻譯只顯示中文譯文（2026-11-04）

原本網頁譯文一律附在原文後。新版可在側欄勾選「只顯示中文譯文」，立即切換目前網頁已完成的正文。取消勾選回到雙語，按「還原目前網頁」則移除譯文並清除顯示設定。新網頁預設為雙語。尚未翻好的段落、反白翻譯、表單和媒體等需保留的內容仍可見。已替換段落內的原始連結，可取消勾選後使用。

**資料流與取捨。** `panel.html` 的勾選由 `panel.js` 以 `qingread:display` 傳到目前網頁的文件 ID。 `content.js/setDisplayMode()` 切換該文件的顯示方式，`placeTranslation()` 重用已完成的譯文，用樣式隱藏原文元素，表格格子與清單項目則用同類型的替代元素保持結構。原本的文字節點和頁面程式持有的物件都留在原位。 `readOriginal()` 在同步讀取時短暫停用隱藏樣式，讓摘要和原文比對讀到原文。原文變動時，`pruneRendered()` 會撤下舊譯文並恢復更新後的原文。

**排查與維護。** 先重載外掛並刷新來源網頁。翻譯一段後勾選及取消，確認原位譯文與雙語都能切換。若某段仍顯示原文，先確認該段翻譯完成，再看 `canReplace()` 是否因該區塊包含控制項或其他未翻文字而保留原文。要新增需保護的控制項時，可將選擇器加入 `PROTECTED_CONTENT`，用同段含該控制項與普通段落做對照，並驗證「還原目前網頁」及摘要仍能讀到原文。若要重跑，用 `npm.cmd test`，設定 `CHROME_PATH` 後執行 `npm.cmd run test:browser` 和 `npm.cmd run test:extension`。

**驗證。** 56 項 JavaScript、124 項 Chromium 測試通過。新增同份文件雙向切換、切換分頁、表格欄寬屬性、清單編號、標題結構、摘要讀取原文、原文更新後恢復及完整還原。另在真正載入外掛的獨立 Chromium，用固定譯文完成勾選切換及原文恢復，報告為 `test-results/extension-smoke.json`。這批驗證顯示與工作流程，真實模型譯文品質仍需逐頁確認。

## Ollama 技術文件段落與行內程式碼（2026-11-04）

Ollama 文件用 `span[data-as="p"]` 表示段落。舊版會把這類文字歸到外層容器，造成多段譯文集中在同一處。同時，行內 `code` 和大段範例一起被排除，`/api/show`、`true` 等名稱在讀取階段就消失。範例語言分頁是有 `role="tab"` 的列表項目，舊版會把標籤當成文章翻譯。 [Ollama Thinking 文件](https://docs.ollama.com/capabilities/thinking)

**資料流。** `content.js` 辨認文件正文、頁面標題和個別段落，將一般文字及須原樣保留的行內文字分開記錄，排除大段 `pre` 範例和分頁標籤。側欄呼叫 `core.js/translateWebItem()`，暫時用標記替換行內文字，讓引擎讀到完整句子。每個標記均完整保留時，清讀套用詞彙表後放回原文字串。標記遺失或重複時，分別翻譯周圍的文字並拼回，句子可能較不流暢。最後 `content.js` 比對原文與片段類型，確認相符才將譯文放回對應段落。

**排查與維護。** 重新載入外掛、刷新原網頁再開始。若譯文仍集中在頁尾，先檢查該網站是否用自訂元素表示段落，並查看 `content.js` 的 `BLOCKS` 與 `DOC_BODY`。若只有欄位名消失，先確認 `qingread:collect` 回傳的 `parts` 含 `literal`，再檢查引擎回應和送往 `qingread:apply` 的文字。要新增文件版型時，先用實際的段落結構做精簡測試，驗證段落各自插入、行內名稱保留、分頁及大段程式碼排除。

**頁面驗證。** 以隔離 Chromium 載入當日官方 HTML，停用網站腳本及外部資源。擷取由 17 項變成 21 項。新版辨識主標題、分開兩段前言，並保留 `/api/show`、`message.content` 和 `values: [false]`。兩組範例的語言標籤均排除，且以固定引擎回應驗證譯文插在對應段落後。56 項 JavaScript、122 項 Chromium 測試通過，另以實際載入的外掛確認網站授權與正文讀取。此測試未量測真實引擎的翻譯品質。

## 網頁譯文與 PDF 工作啟動修復（2026-11-04）

**網頁流程。** 側欄 `panel.js` 持有瀏覽器文件 ID 和本次工作 ID，透過 `qingread:collect` 讓 `content.js/collectAttempt()` 讀取正文或反白。每筆工作記下來源範圍及實際送翻的原文。引擎回傳後，`qingread:apply` 透過 `sourceOf()` 依原來的過濾規則重讀區塊，原文相符才插入。原本只比對已記錄的舊節點，段落新增行內元素可能漏判。反白用固定的文字節點和字元位置比對該段範圍，與全文譯文分開去重。新反白結果替換上一次反白譯文，完成同段全文時也會撤下該段反白譯文。

**頁面變動。** 已顯示譯文由 `pruneRendered()` 隨網頁結構和屬性變動重新檢查，撤下失效譯文後可手動重翻。擷取時只把正文、補充閱讀範圍、會影響可見性的祖先及樣式變動納入判定。正文範圍變動可重新擷取一次，持續變動會顯示頁面變更提示。反白保留原選取範圍，取消或被更新的工作不會重試。摘要共用正文擷取，但保留獨立的工作識別與擷取完成後的來源快照。

**PDF 流程。** `workspace.js/submitPdf()` 送出 `POST /pdf`，`app.py/start_pdf()` 驗證檔案與試翻範圍，然後透過 `new_job()` 在同一個鎖內保留名額、寫入 `input.pdf` 和 `options.json`、保存 `job.json` 並啟動背景工作。鎖確保同一時刻只有一份文件或資源準備工作能通過登記。寫入或啟動失敗回傳 `JOB_START`，釋放名額並清理該筆工作目錄。工作狀態先寫入暫存檔再替換正式檔，寫入失敗時避免損毀上一份狀態。啟動復原也會嘗試清除中斷工作殘留的 `options.json`，再讀取工作狀態。

**排錯與自行維護。** 若固定句可以翻譯但網頁漏翻，先用反白測試，再看 `collect` 回傳的段落和 `apply.applied`。若要調整網站正文規則，先改 `readingRoot()` 或 `sourcePart()`，再同時驗證正文外旁欄更新可忽略、正文內新增行內文字會讓舊譯文失效。若收到 `JOB_START`，先確認助手資料磁碟有空間且工作目錄可寫，再重試一次。若舊助手留下排隊中的工作，確認沒有其他工作執行後再重啟，從工作室清理該筆工作。可用 `npm.cmd test`、設定 `CHROME_PATH` 後跑 `npm.cmd run test:browser`，以及 `.\companion\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'`。

**驗證。** 54 項 JavaScript、121 項 Chromium、54 項 Python 測試通過。另用 `npm.cmd run test:extension` 實際載入開發外掛，確認未授權時的拒絕、工具列授權及正文擷取。新案例涵蓋同段反白重選、反白以外文字變動、晚到譯文拒絕、旁欄更新、正文重取與持續變動，另模擬 PDF 輸入、設定、狀態寫入及背景執行緒啟動失敗，並確認兩份同時提交仍只有一份入列。這批未重測真實模型、PDF 排版品質或日常 Chrome 設定檔。

## 字幕側欄收合與背景工作（2026-11-02）

**問題與使用方式：**原本 video.js 的 session、Translator、音訊軌與輪詢都依附側欄，visibilitychange 隱藏或 pagehide 銷毀即 stop；單純刪停止事件無法保證關閉後繼續。現在新增「收合側欄，繼續字幕」，兩階段交接成功才關閉介面。開始字幕 → 按收合 → 等背景接手 → 使用播放器全螢幕；影片右上角「停止清讀字幕」或重開清讀側欄均可停止。沒有交接就直接按側欄 × 仍按原規則停止。收合僅處理字幕，不承諾摘要、網頁或文字翻譯也移至背景。

**檔案與資料流：**
1. `video.js` 保存開始時 engine／source／mode／雙語／詞彙設定及來源 documentId；收合送 `qingread:video-control/prepare`。`video-background.js` 僅接受 panel.html 控制，檢查設定及目前來源分頁，建立 `video-offscreen.html`。
2. `video-offscreen.js/prepare()` 在隱藏頁建立同一引擎。本機憑證以受限的 `qingread:video-host/token` 回覆取得，只交給外掛自身背景頁；不交給影片內容腳本。Chrome 語言包嘗試重建已準備的語言組合；失敗時回報，原側欄工作保留。未提交的引擎 20 秒後清除；取消、來源換頁或晚到引擎都清理。
3. 現有字幕已依 2026-11-04 的修正改成背景 `commit(ticket)` 在同一 documentId 接管成功後，側欄才釋放自己的 session，頁面字幕框與時間線會保留。語音模式仍先停止側欄音訊，再透過 service worker 重新取得分頁音訊 ID，在 offscreen 建 AudioContext／AudioWorklet，可能有短暫音訊空檔。
4. `video-clock.js` 專用 worker 每 250 ms 驅動共用 `video-pipeline.js`。原本字幕穩定、略過過期結果、雙語顯示、語音重疊去重與有限緩衝規則集中在 pipeline，側欄及背景共用，避免兩套版本漂移。背景透過受限訊息請 service worker 對固定 documentId 送 media-read／show；真正模型請求仍經 local-client.js 與助手。
5. commit 成功才呼叫 `sidePanel.close`。重開側欄以 status 回復控制；`media-content.js` 在背景 session 顯示小型停止按鈕，與字幕一起移入播放器的 fullscreenElement。停止請求須通過 extension id、來源 tabId、documentId 及 session id 驗證，舊文件不能停止新工作。
6. 停止／來源變更 → 終止 worker、abort 模型、停止音訊軌、關閉 AudioContext、移除字幕與按鈕並恢復原字幕 → 等模型清理完成 → 約 4 秒後檢查仍無工作才關閉 offscreen。建立與閒置關閉依序處理，避免舊清理關掉新準備的引擎。

**架構依據與取捨：**[Chrome offscreen 文件](https://developer.chrome.com/docs/extensions/reference/api/offscreen) 說明隱藏頁只能使用 runtime 擴充 API，因此 tabs／storage／tabCapture 由背景腳本代辦，不能直接把側欄程式原封搬過去。manifest 新增 offscreen 權限，使用 WORKERS 與 USER_MEDIA 原因；不新增全網站常駐讀取。全外掛目前只允許一個背景字幕工作，第二次準備拒絕，不偷換另一部影片。[Chrome sidePanel.close](https://developer.chrome.com/docs/extensions/reference/api/sidePanel#method-close) 自 Chrome 141 提供；最低版本仍 138，舊版背景接手後明確提示手動按 ×。原生 `<video>` 自身的全螢幕不能容納 HTML 字幕，這次支援／驗證的是 YouTube 類型的播放器容器全螢幕。音訊背景架構參照 [Chrome 分頁音訊擷取](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture)，未改用麥克風或整台電腦錄音。

**驗證與限制：**54 項 JavaScript 單元測試、118 項瀏覽器回歸通過。新增六例背景生命週期／權限測試，涵蓋只準備不觸碰來源、單次提交、取消晚到 Chrome 引擎、準備時來源變更、語音資源釋放／晚到音訊及非法請求拒絕；新增三例收合 UI 測成功、準備失敗仍保留字幕，以及交接中取消不得關側欄。既有影片、語音緩衝、正文、摘要、配對及 PDF 回歸全部保留。

`tests/background-video-smoke.cjs` 已用人工模型及 `--live-model` 真正本機模型各通過一次：真實載入外掛／offscreen／worker，銷毀原控制頁後接收下一句雙語字幕，真實容器全螢幕內仍顯示，重開控制能讀回狀態，影片內停止移除字幕及控制，閒置背景頁釋放。報告 `test-results/background-video-smoke.json`（liveModel true）、畫面 `test-results/background-video-fullscreen.png`。影片 DOM 與字幕是人工資料，並未實際播放 YouTube；本機譯文品質不由這個生命週期測試保證。Chrome 語言包在 offscreen 的真實可用性、首次下載及語音真實音訊交接尚未驗收；單元測試的 Chrome 引擎和音訊軌是替身，不當作真實環境證據。

第一輪整合測試發現 Playwright 的一般頁面路由不攔截 offscreen fetch，人工 token 因而被日常助手拒絕（401）；沒有取得日常配對憑證或送出模型工作。已修正測試：複製外掛到隔離目錄，只把固定 loopback 連接埠及 CSP 改為測試助手的隨機 port；正式外掛仍固定 8765。後續測試不使用日常助手資料。報告與臨時外掛／瀏覽器資料不納入 Git。

**啟用與排錯：**重載外掛 → 重開側欄 → 刷新影片頁 → 開始字幕 → 按收合。按鈕停用先看字幕是否尚在準備；出現「目前 Chrome 無法在背景啟動這組語言包」時原字幕仍繼續，可保持側欄，或停止後手動選已配對本機模型再開始。背景接手後沒有自動收起，先看是否提示舊版手動按 ×；新版則檢查側欄是否屬於原視窗。只換全螢幕不應停止；同視窗切換另一分頁仍會停止。若重開側欄沒有背景狀態，檢查是否換址、關閉來源、外掛重新載入或瀏覽器重啟，這些不會自動恢復錄音。不要以刪除助手 config 或重新下載模型處理側欄問題。

維護時依序查看 `video-background-status`（交接錯誤）→ `video-status`（引擎運行狀態）→ 擴充功能管理頁的 service worker／offscreen 錯誤。安全診斷可只查 `chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})` 確認是否存在背景頁，不列印 token／原文／Authorization。停止仍失敗可刷新來源頁，若背景資源仍殘留則重載外掛；音訊軌隨背景頁銷毀終止。若要改按鈕位置，改 media-content 的 positionControl，並一起驗證進出全螢幕及小播放器；若要調輪詢速度，需一起改 video.js 的側欄間隔及 video-clock.js 的背景間隔，重跑字幕舒適閱讀與最新句優先測試。只改其中一處會讓收合前後行為不同。

測試命令：`npm.cmd test`、設定 CHROME_PATH 後 `npm.cmd run test:browser`，整合為 `node tests/background-video-smoke.cjs --live-model`。本輪未修改助手，未重跑 Python，也未重新打包發行版。

## 摘要來源保留與記住配對（2026-11-02）

**問題與行為：**使用者回報反覆配對、摘要耗時且切換分頁重來。先前為避免錯頁結果採用換頁即取消，卻使等待綁住閱讀。本輪將摘要定義為「擷取當時原文的快照」：尚未取得原文時換頁仍取消；取得後切換分頁、來源換址或關閉，都不取消推論、不清空部分／完成結果。來源名稱透過 textContent 顯示（不解讀網頁標題中的 HTML），複製時附上來源與範圍。開始下一份才取代上一份；目前不做多份歷史與背景持久化，關閉側欄仍會停止未完成工作。這節取代下方歷史紀錄中摘要一律換頁取消的政策，網頁翻譯與影片字幕仍按原規則取消。

**摘要資料流：**`panel.html` 整理目前分頁摘要 → `summary.js` 取得來源 tabId、windowId、標題 → inject/send 的 `qingread:summary-source` 回傳段落 → 截取前 6,000 字元並設 `captured=true` → `local-client.js/request('/summarize', {managed:true})` → 本機助手工作 → 增量顯示 → 完成保留。`showSource()` 管理來源說明；`sourceMoved()` 及 onActivated 依 captured 判斷是否取消。停止與 pagehide 仍走原 AbortController／助手 DELETE；舊回應必須核對 task 身分。單份快照不需要重讀來源，因此生成完成時不再要求來源仍為目前分頁。

**配對資料流：**`workspace.html` 預設不勾選「記住這台電腦」 → `workspace.js` 在一鍵／手動配對傳 remember → `local-client.js/pair()` 驗證 `/health` 後寫入 session.companionToken；只有 remember 為 true 才寫 local.rememberedCompanionToken。兩種 storage 的存取範圍都限制為 TRUSTED_CONTEXTS（外掛自身頁面，不含網頁內容腳本）。`savedToken()` 先查 session、沒有才查本機持久儲存；翻譯、摘要等共用此入口，沒有新增雲端請求、同步或文章儲存。

`rememberDevice(true)` 會重新驗證目前憑證；未配對時只保留勾選供下一次配對使用，不憑空保存。取消勾選時把有效憑證保留於 session 再刪除 local，避免立刻斷線；`forgetDevice()` 清掉兩者。工作室的 connectionEpoch 阻止清除後晚到的 health／jobs 回覆把畫面恢復成已連線。credentialRevision 使同一頁中舊的驗證結果失效，credentialWrites 依序完成儲存操作，避免先前延遲寫入蓋過後來清除。這不是助手的全域撤銷；已帶憑證送出的請求仍可能完成，也不會改動其他 Chrome 設定檔或助手 config.json。持久儲存不等於作業系統加密憑證庫，因此預設關閉且提供清除入口。

**速度與邊界：**這輪不調模型、不改雲端、不改 180 秒預算，改善的是等待期間可做其他事。尚未實作關閉側欄後復原、瀏覽器重啟後復原摘要、並行多份摘要或助手自動啟動。原始標題／主機名僅用於來源標示，並非摘要正確性的保證。切回來源頁也不會把快照改成最新內容，要更新需主動開始下一份。

**排錯順序：**先重載外掛並重開側欄／工作室，避免舊腳本還在記憶體。摘要若換頁即停止，確認換頁前是否已顯示「依開始時擷取的原文整理」；仍是「正在擷取」時停止屬預期。若讀取完成後停止，檢查側欄是否被關閉／重新建立，再查 summary 的 captured 與 task 身分；不要先放寬網站授權。記住後仍要求配對時先確認相同 Chrome 設定檔、勾選狀態與助手已啟動，再檢查 health 是否為 401（助手憑證更換）或無法連線；401 可重新配對，無法連線應先啟動助手。不要把配對碼、storage 內容或 Authorization 標頭貼進 log／截圖。清除保存請用「忘記這台電腦」，不用刪助手資料或模型。

**自行修改例：**要調摘要最多讀取字數，需一起改 `summary.js` 的切字／範圍說明、`panel.html` 提示，以及助手輸入限制與對應測試，不能只改畫面。若想改成關閉側欄也繼續，不能只刪 pagehide：需要將工作管理移到背景、保存工作 ID／來源／部分結果並處理重新連線；這屬下一階段架構變更。配對新增儲存方式時統一改 savedToken／pair／rememberDevice／forgetDevice，避免其他功能仍只查 session。

**驗證：**48 項 JavaScript 單元測試、115 項完整瀏覽器測試通過。首輪三個工作室／PDF fixture 尚未提供新增的 storage.local，造成等待逾時；補齊測試環境後完整回歸通過，未放寬正式程式的儲存要求。隔離 Chromium 真正關閉再開啟，session 為空時能使用已保存憑證，忘記後重載仍維持未連線；報告 test-results/pairing-restart.json。正式助手／既有 Gemma 3 4B 以經濟部公開 DOM 快照測得 42.843 秒完成 197 字元摘要；生成途中用原生分頁切換及 history.pushState 變更來源網址，沒有送出 DELETE 且摘要完成。並驗證快取、主動停止、停止後重試、模擬斷線恢復，以及網頁／影片仍遵守換頁取消；報告 test-results/moea-stability-smoke.json。這不等於使用者日常側欄、原生配對同意視窗、摘要品質或所有網站已全面驗收。測試入口為 `npm.cmd test`、設定 CHROME_PATH 後 `npm.cmd run test:browser`，另有 `node tests/pairing-restart.cjs`（隔離 Chromium 真正關閉再開啟；HTTP 為人工回應、不模擬原生同意視窗），以及 `node tests/stability-smoke.cjs --live-model --article-snapshot test-results/moea-article-snapshot.json`（真實助手／模型與公開 DOM 快照）。助手程式未修改，未重跑 Python。

最後另跑 22 項摘要相關瀏覽器測試，確認停止／讀取失敗後來源提示不再停留於「正在擷取」，全部通過。

**前次版控阻擋紀錄：**此批第一次提交因自動核准服務用量上限未執行，當時最後提交為 `608e66e`。核准流程現已可用，本輪收尾與字幕背景收合成果一併保存；實際提交以 `git log -1 --oneline` 核對。不要用 reset／clean 清掉未提交成果；目前沒有遠端備份。

## 經濟部整頁表單正文誤排除（2026-11-02）

回報頁：[經濟部科技新知文章](https://www.moea.gov.tw/MNS/doit/industrytech/IndustryTech.aspx?menu_id=13545&it_id=563#top)。使用者看到「沒有讀到正文。請先展開要閱讀的內容再試」。此訊息由 `summary.js` 在 `batch.items` 沒有可用文字時產生，尚未呼叫摘要模型。最初測試瀏覽器遭網站 403 阻擋，不能用它推論使用者也遭阻擋；取得使用者對瀏覽工具的網站存取授權後，已成功讀取實際頁面並確認原因。

**根因與缺漏：**該頁 DOM 是 `body > form#form1`，表單包含 ASP.NET 的隱藏狀態欄位、頁首搜尋、`#divMain > #divBox > #divContent` 正文及頁尾。沒有 main／article 地標。舊 `content.js/EXCLUDE` 把 form 及所有後代一律排除，正文因此讀到 0 段。舊測試只驗證一般輸入表單必須排除，沒有覆蓋「公開文章被整頁表單包住」的版型；這是擷取規則與測試缺口，不是使用者沒有展開文章。

**實作與取捨：**`pageFormArticle()` 僅接受 `www.moea.gov.tw`／`moea.gov.tw` 的 `/MNS/doit/industrytech/IndustryTech.aspx` 路徑（大小寫不拘），且必須同時有 `#divContent`、其外層 `form#form1` 直接位於 body、隱藏 `__VIEWSTATE` 欄位、文章標題 `#holderContent_lblTitle` 與摘要 `#holderContent_lblIntro`。符合時以 divContent 作為正文根節點；只有這個根節點內、屬於該外層 form 的文字可略過 form 排除。不靠單一 form ID、政府網域或可見字數就全面開放表單，也不放寬其他網站／經濟部其他功能頁。

`excluded(element, context)` 把一般元素排除與 form 邊界分開：input、textarea、select、button、隱藏、可編輯區等仍一律排除；表單內另排除 label、fieldset、role=form／search 的群組。label 額外排除限於表單內，因既有課程 FAQ 會用 label 顯示問題。`readContext()` 每次擷取／分批／套用譯文都重新確認版型資格，避免網站內容變動後沿用過時例外。`readableRoot()` 同一輪檢查共用 context，保持長頁快取設計。

**資料流：**整理摘要 → `summary.js` 注入並送 `qingread:summary-source` → `content.js/readingRoot()` 找到已驗證的文章區 → `allowed()`／`excluded()` 過濾表單元件與不可見內容 → 回傳原文段落 → summary 以空行串接、最多 6,000 字元 → `local-client.js` 驗證助手能力並建立本機摘要工作 → 顯示結果。網頁翻譯共用此擷取規則，套用譯文前仍以 `textOf()` 重新檢查可讀性；摘要讀取已翻譯頁時仍取原文，不重複收錄清讀譯文。

**證據與限制：**實際公開頁確認文章為 Graph RAG 技術介紹，表單與正文容器結構如上。從已授權頁面只保存 `#divContent` DOM，移除 script、img，不保存隱藏表單值或瀏覽憑證；快照位於忽略 Git 的 `test-results/moea-article-snapshot.json`。同一份快照以舊程式擷取 0 段／0 字元，修正後 22 段／4,678 字元；summary 的段落間空行合計另加 42 字元，介面顯示 4,720 字元。

`tests/stability-smoke.cjs --live-model --article-snapshot test-results/moea-article-snapshot.json` 在隔離 Chromium 載入真正外掛，將文章網址回應替換為已取得的 DOM 快照，依觀察到的層級重建 form，透過原生工具列 activeTab 授權、正式助手 HTTP 程式與既有 Gemma 3 4B 完成摘要；單次 39.831 秒、197 字元輸出。報告 `test-results/moea-stability-smoke.json`、畫面 `test-results/moea-summary.png`。此為真實模型與外掛搭配實際文章 DOM 重播，未重播網站 CSS／腳本、未在使用者日常 Chrome 側欄驗收，也未逐句驗證摘要品質。整合流程另確認快取、停止後重試、模擬斷線恢復、文字翻譯及換頁取消。

提交的 `tests/fixtures/moea-article.html` 只保留已觀察的版型、人工文字與人工敏感欄位標記，不包含真實文章全文。三個新增測試覆蓋正文／原文重讀、範圍限制（其他 host、其他 path、缺少狀態／標題、form 不在 body 下）、版型改變後拒絕套用舊譯文。修正前兩例失敗，修正後通過。完整回歸曾發現 Skilljar FAQ 的 label 受影響，已修復，不能只跑新案例就當完成。

最終驗證：43 項 JavaScript、110 項瀏覽器測試全數通過。本批助手未改動，未重跑 Python。另於本次收尾查詢正在執行的助手，`ollama`、`inference_jobs`、`inference_client_identity` 皆為 true；因此本次毋須再重啟助手或重新配對。此為本次觀測，不代表未來程序重啟後永遠維持相同狀態。

**啟用與排錯：**重載清讀 → 重開側欄 → 重新整理該經濟部文章頁 → 再按整理摘要；本批沒有助手變更。若仍顯示空正文，先確認來源頁已刷新，避免仍使用已注入的舊 `content.js`；其次檢查網址是否為上述文章路徑、divContent 是否可見、form／標題／摘要標記是否仍存在。若頁面顯示網站阻擋而不是文章，先處理網站可讀性，不能靠放寬擷取解決。若改成助手相容性或配對錯誤，表示已通過擷取，依助手章節排查。不要為了這個錯誤刪設定、重抓模型或反覆授權網站。

**自行修改例：**網站若將正文 ID 改名，需先查看實際 DOM，再一起改 `pageFormArticle()` 的 selector 與人工 fixture，重跑 `npm.cmd run test:browser`；不能只刪掉 form 檢查。要支援另一個整頁表單網站，新增明確驗證的文章容器規則及主機／路徑限制，並補普通表單不能洩出、欄位群組不能讀、版型失效拒絕舊結果與既有 FAQ 回歸。記錄資料流與例外範圍，避免讓表單例外默默擴大。

## 換頁取消與單字解釋重新啟用（2026-11-02）

這批接續穩定性檢查，不新增功能。已在修改前用六個失敗案例重現：網頁／影片各自遇到只有 URL 更新或來源關閉時沒有停止；滑過單字關閉後未取消助手請求；讀詞回覆晚到後仍提交模型。另補三例保護準備期間的來源視窗、舊啟用失敗與新查詢互不干擾，完整瀏覽器測試由 98 增至 107 項。

**檔案與流程：**`panel.js/start()` 在 `activeTab()` 回來時先記錄 tabId／windowId，再等待注入讀取程式；`video.js/target(check)` 在注入前檢查該次操作仍有效，並由字幕啟動流程保存同樣來源資訊。`tabs.onUpdated` 的 loading 或 URL 變化、`tabs.onRemoved` 的來源關閉 → 比對來源 ID → `cancel()`／`stop()` → AbortController 發出取消訊號 → 本機翻譯器透過 `local-client.js/runInference()` 取消該筆助手工作 → 舊結果被工作身分檢查拒絕。影片停止另關閉音訊軌、計時器並要求來源頁移除字幕。已插入的網頁譯文維持原有保留政策，不自動回復原文。

原本等待注入完成後才有視窗資訊，其他視窗的操作可能誤停準備中的工作；現在一取得來源就保存。僅有來源資訊後才能區分視窗，尚在最初分頁查詢時仍採保守取消。關閉分頁沒有可接收清除訊息的文件，忽略清除失敗，但側欄與助手的取消仍照常執行。

**單字查詢的生命週期：**啟用 → health 檢查 → 取得目標文件 → `qingread:hover-enable` → 每 600 ms 以 `qingread:hover-read` 讀詞 → 再核對目標與啟用代次 → `/explain`（帶該次查詢的 signal）→ 再核對 → `qingread:hover-show`。`hoverEpoch` 是每次開關遞增的代次編號，可視為本次操作的識別碼；`hoverLookup` 保存查詢本身與其 AbortController。停用時先增加代次、取消並清空 lookup、取消勾選，最後通知頁面關閉提示。

重新啟用可建立新的 lookup，無須等舊網路回覆。舊回覆／舊錯誤只有在 target、epoch、lookup 三者仍相符時才可更新介面。finally 清理時也必須核對 lookup，避免舊請求結束反而解除新查詢的鎖、造成重複送出。啟用 health 回應若過期，同樣不能取消新啟用或顯示舊錯誤。這裡取消的是已送出的單字解釋；啟用前的唯讀 health 檢查仍可能完成，但不再影響新狀態。

**取捨與邊界：**網址只改 hash（井字號後的片段）也會停止，與摘要採相同保守政策，以避免網站用 hash 路由切換內容時套用舊翻譯。一般影片快轉若沒有改網址，仍走原有播放時間線處理。本批未實作「移到另一個單字就立即取消前一個查詢」；停用／來源改變才取消，其餘由頁面 wordVersion 拒絕過期提示。語音 Whisper 舊辨識流程是否立即釋放模型，仍依既有限制，不因前端停止就宣稱完全終止運算。

**驗證：**43 項 JavaScript 單元測試、107 項瀏覽器測試全部通過，助手未改動，本批未重跑 Python。`tests/stability-smoke.cjs --live-model` 已擴充並通過：真實載入外掛、原生工具列 activeTab 授權、正式 HTTP 助手與 Gemma 3 4B，網頁及人工影片 DOM 各啟動一筆真正的本機翻譯，再以 `history.pushState` 產生 Chrome 的同頁換址事件；觀察到 DELETE、cancelled、介面停止及無字幕殘留。此測試保留原有公告摘要、快取、停止後重試、斷線恢復與文字翻譯檢查。報告 `test-results/stability-smoke.json` 排除於 Git。影片 DOM／字幕是人工資料，並未實際播放 YouTube 或錄製分頁音訊；單字重啟競態是模擬慢回應的瀏覽器流程驗證，不能宣稱原生滑鼠互動與模型詞義品質已全面驗收。

**啟用與排錯：**本批只需重載外掛、重開側欄、重新整理來源頁。若前一批舊助手仍未重啟，先依下一節完成更新。重現時先開始翻譯，於尚在處理時在原分頁切換文章／影片；應看到「來源頁面已變更」且開始按鈕恢復。本機模式可再觀察「助手已確認」；若只有已送取消但未確認，先檢查助手連線，不把介面停止誤認為模型已結束。單字解釋可在等候時取消勾選後再勾選，第二次查詢應能進行，舊錯誤不應突然出現。若仍套用舊結果，先排除未重載外掛／來源頁，再檢查來源 tabId、windowId、工作 ID、hoverEpoch 與 lookup 身分；不要記錄原文、配對碼或完整請求標頭。

**自行修改例：**要調整單字輪詢速度可修改 `video.js` 的 600 ms，但必須保留每次 await 後的身分核對與 finally 條件清理，並重跑「關閉後重啟」「舊 read 晚到」「舊 setup 失敗」案例。要讓部分網址變更不中止，需同時修改 panel／video／summary 的來源判斷與測試，明確區分只是錨點跳轉或已換文章，不能直接刪掉 URL 檢查。測試命令沿用下一節；本次新增案例位於 `tests/browser.test.cjs`，真實模型整合入口為 `node tests/stability-smoke.cjs --live-model`。

## 穩定性檢查與執行中助手相容性（2026-10-30）

**實際發現：**本輪以已配對憑證查詢正在執行的 `127.0.0.1:8765/health`，回報 0.3.8、Ollama 可用、Gemma 3 4B、PDF preview 可用，但缺少 `inference_client_identity`。磁碟上的程式已具備該欄位，表示執行中的助手尚未載入前一批修正。查詢不輸出配對碼。這能解釋摘要工作歸屬錯誤持續發生的可能原因，不能推論所有使用問題都出自舊助手。

**修改與取捨：**`extension/local-client.js/runInference()` 在每一筆工作送出前檢查 `inference_jobs === true` 和 `inference_client_identity === true`。缺少能力時使用 `COMPANION_UPDATE_REQUIRED` 錯誤，明確告知先結束重要工作、關閉助手視窗、重新啟動本專案 `companion/start.cmd`。不單靠版本字串，因不同開發批次目前可能同為 0.3.8。不快取能力檢查，避免助手重啟後沿用過時判定；代價是每筆工作多一次本機 health 查詢，其時間包含在既有 180 秒工作期限內。這不能排除 health 成功後助手立刻重啟的競態，真正工作遺失仍依原有錯誤處理。

資料流：功能按鈕 → `QingReadLocal.request(..., managed:true)` → 取配對碼 → `GET /health`（不含原文）→ 驗證能力 → `POST /inference/{id}`（此時才送原文）→ `GET` 查詢進度／結果；停止或逾時才對已開始的工作 `DELETE`。檢查過程停止，不建立工作，也不刪除不存在的工作。配對檢查仍只確認憑證，不把新能力當成基本配對必要條件，避免影響舊助手仍可用的其他功能。

`extension/summary.js` 同時補上來源生命週期：來源分頁 `tabs.onUpdated` 只有 URL 更新也清除摘要；`tabs.onRemoved` 關閉來源同樣取消。部分網站用同一文件切換內容，網址會變、卻沒有 loading 事件，原本只看 loading 會漏掉。採保守判定，連只改網址片段也清除；維持原網址而自行更新內文不在這項監聽範圍。其他分頁的更新／關閉不影響目前工作。

**驗證範圍：**新增的相容性三例、摘要換頁與關閉兩例皆先在修改前確認失敗，再確認修正後通過。完整回歸為 43 項 JavaScript、52 項 Python、98 項瀏覽器測試；受限環境無法啟動 Chromium 與使用部分本機測試連線，開放測試所需的本機執行後通過，不能把最初環境失敗算成產品缺陷。

| 流程 | 本輪證據與邊界 |
| --- | --- |
| 初始無網站權限 → 待確認請求 → 工具列暫時授權 → 讀正文 | `tests/extension-smoke.cjs`，真正載入外掛與原生 Chrome API；正文為固定人工頁面。修正其仍只接受舊按鈕「允許」的過時斷言。 |
| 新外掛接舊助手 | `tests/inference-origin-smoke.cjs --legacy-owner`，真實外掛與正式 HTTP handler，模擬舊能力與擁有者規則；只有一次 GET health、零次 POST，顯示重啟說明。此旗標現在驗證相容性阻擋，不再期待先送原文再出 404。 |
| 新外掛接新助手 | 同上不加旗標，真實 POST／GET Origin 差異，固定人工模型回應，成功完成。 |
| 真實公告摘要 | `tests/stability-smoke.cjs --live-model`，原生工具列 activeTab 授權，實際 NTTU 公告正文、正式助手程式與 Gemma 3 4B；最後一次 14.199 秒、167 字元輸出。只確認流程完成，未逐句驗收摘要品質。 |
| 快取、取消、重試、文字翻譯 | 同一隔離外掛／助手測試。固定人工原文首次 5.035 秒、重複 0.998 秒；停止後助手回 cancelled，新摘要 14.038 秒完成；模擬連線拒絕後重試 1.006 秒（命中快取）；實際本機文字翻譯成功。數值僅為這次樣本，不是速度保證。 |
| 尚未完整驗證 | 真實原生配對確認、持久網站權限確認視窗、使用者日常 Chrome 設定檔、Chrome 語言包、實際影片及語音擷取、多語與複雜 PDF。本輪不把這些列為已驗收。 |

真實模型測試使用獨立助手資料／假配對碼／隔離瀏覽器設定檔，保留正式 manifest，將固定 loopback 請求轉送到測試助手的隨機本機埠，模型回應不模擬；未操作真正配對確認視窗。只讀正式設定中的模型選擇，不更改正式設定與目前服務程序。首次快取斷言使用動態公告頁而失敗，因正文可能隨載入改變；已改用固定人工原文檢查快取，不要求不同原文共享結果。報告 `test-results/stability-smoke.json` 不含配對碼或正文，排除於 Git。

**排錯與啟用：**先結束重要工作，關閉舊助手視窗，執行本專案 `companion/start.cmd`，再於 Chrome 重載清讀、重開側欄並重新整理來源頁。若仍出現更新提示，先確認開啟的是此專案的 start.cmd，而非另一份舊專案；檢查工作室能否連上、選定模型是否可用，再對照 health 能力。不要刪除個人設定或重新下載模型來處理程式未重啟。正式助手本輪未自動重啟，避免中止使用者其他工作。若只有網頁讀取失敗，依下一節的網站授權流程排查；若人工短文也不能翻譯，再檢查助手與模型。

可安全重跑的測試（在專案根目錄 PowerShell）：

```powershell
npm.cmd test
.\companion\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'
$env:CHROME_PATH='C:\Users\lydai\AppData\Local\ms-playwright\chromium-1223\chrome-win64\chrome.exe'
npm.cmd run test:browser
npm.cmd run test:extension
node tests/inference-origin-smoke.cjs --legacy-owner
node tests/inference-origin-smoke.cjs
node tests/stability-smoke.cjs --live-model
```

`CHROME_PATH` 是本機已安裝且可載入未封裝外掛的 Chromium，其他電腦需改成實際路徑；真實模型測試會使用本機運算資源並讀取上述公開公告，不是離線快速單元測試。勿使用舊 `integration_local.py` 當無副作用驗收：它會修改正式模型設定；本輪使用的新測試具隔離資料。

**自行維護例：**日後新增需要助手支援的協定欄位，先在助手 health 宣告能力，再於 `runInference()` 一起檢查；同步補「缺能力不得 POST」「停止檢查不建立工作」「重啟後重新檢查」三類案例。摘要若要放寬純錨點跳轉不清除，需在 summary 的來源比對保存／比較不含 hash 的網址，並測試 hash 路由網站，不能直接忽略所有 URL 更新。每批修改仍需更新本文件、CHANGELOG 與 Git；測試通過不等於目前日常程序已更新。

## 摘要網站授權迴圈修正（2026-10-30）

回報網址為 `https://aa.nttu.edu.tw/p/406-1002-179272,r1386.php?Lang=zh-tw`。真實隔離 Chromium 重現初始網址被隱藏，未授權時不能注入；透過原生工具列動作取得 activeTab 授權後，可讀到 12 段／468 字元，並完成使用固定人工模型回應的摘要流程。此結果確認公告可讀，不能據此宣稱使用者日常瀏覽器的權限已被修改或真實模型品質已驗收。

原本未知網址的按鈕只呼叫 `permissions.addHostAccessRequest()`，這只是把請求放入 Chrome 介面，並不等於使用者已允許；重複點擊也不會自動核准。現在區分「已提出請求」與「已實際讀取成功」，對同一分頁不重複送出待確認請求。使用者在 Chrome 確認後，按「檢查網站存取」會先重新嘗試載入，成功才隱藏授權控制。

隱藏網址時，摘要提供目前網址輸入欄。`summary.js` 在點擊內以 `siteTargetFromUrl()` 解析網址 → 只取 http／https 的 origin 與單一 hostname 權限樣式（不接受帳密）→ `requestSiteAccess()` 在第一個 await 之前發出 `permissions.request`，保留使用者操作資格 → 允許後核對分頁 ID 與實際 origin → `inject()` 驗證 → 重新按摘要開始讀正文。貼上的路徑、query 與 hash 不傳給模型、不保存至 storage，成功或換頁會清空輸入；權限只申請該 hostname 的路徑，不擴大成所有網站。

若 Chrome 回報已授權卻仍拒絕注入，顯示「網站已授權，但 Chrome 仍禁止讀取」及重新整理／檢查網站存取設定／貼正文至文字翻譯的行動，隱藏本次授權按鈕，避免再次誘導重複授權。真正拒絕允許、網站切換、程式檔案遺失等錯誤仍分別處理。摘要與網頁翻譯共用授權 helper，成功時必須驗證注入，不能只看 API 回傳 true。

排錯順序：重載外掛並重開側欄 → 回到公告頁 → 如顯示網址欄，貼上瀏覽器網址列的完整網址，確認按鈕標為「允許 aa.nttu.edu.tw」再按 → 在 Chrome 視窗確認 → 看見「已確認可以載入讀取程式」後再整理摘要。也可直接點 Chrome 工具列清讀圖示取得該頁暫時授權；單純打開側欄選單未必會取得 activeTab。若仍被拒絕，先重新整理網頁與檢查外掛網站存取設定，不要重複點同一待確認請求。本輪助手未修改，無需重啟助手。

維護例：新增另一個需要網站授權的功能時，沿用 `error.accessTarget` 的 tabId、`requestSiteAccess()` 的 granted／message 回應及核對 origin 的步驟；不能拿顯示文字當成授權成功，也不可在先 await 查分頁後才要求持久權限。網址輸入欄必須同時覆蓋無效網址、含帳密、不同目前 origin、換頁清空與未授權不送模型的測試。

驗證：新增貼上 NTTU 網址只申請該 host、成功後能摘要、待確認請求去重、已授權仍拒絕的終止提示，以及錯誤來源／含帳密拒絕等瀏覽器案例。`tests/permission-summary-smoke.cjs` 使用真實外掛與使用者提供的公開頁，原生工具列權限與正文讀取不模擬，只有模型回覆為人工文字；直接 `permissions.request` 的使用者確認路徑則以流程測試驗證，未自動操作真實授權視窗。真實測試報告為排除於 Git 的 `test-results/permission-summary-smoke.json`。

本輪回歸：40 項 JavaScript 單元測試、96 項瀏覽器測試全部通過；助手未修改，不重跑 Python。真實公開頁的原生授權與正文讀取驗證另行通過。

## 摘要「找不到此本機工作」修正（2026-10-30）

使用者實際遇到建立摘要後出現 `找不到此本機工作。`。已用真實 Chromium 外掛重現：POST 有 `Origin`、後續 GET 沒有，DELETE 又有。原本助手只用 `Origin` 或缺少時的 `local` 當作工作擁有者，導致同一個外掛自己的查詢也回 404；這不是模型輸出錯誤。

修正流程：`local-client.js/runInference()` 取 `chrome.runtime.id` → 建立、輪詢、取消都傳 `X-QingRead-Client` → `app.py/inference_owner()` 在既有配對碼及 Host／Origin 檢查後判定來源。標頭格式須為 32 個 a–p 字元；若 Origin 存在，必須與該識別一致；GET 缺 Origin 時使用同一個識別。不提供新標頭的本機腳本保留原行為。這個標頭是公開的外掛身分，不是密碼，不能取代 Bearer 配對碼或作為單獨的授權依據。

完成工作保留期限由 60 改為 180 秒，涵蓋前端工作預算，容量上限仍為 256。真正因助手重啟或過期而遺失工作時，前端保留錯誤代碼，明確提示工作紀錄失效、請重新開始；不自動再次提交原文。摘要已收到的部分結果仍標記未完成，避免冒充完整摘要。

驗證：`tests/inference-origin-smoke.cjs` 使用獨立設定檔及測試用外掛副本、假配對碼與人工原文，啟動正式助手 HTTP 程式；僅模型回應採固定人工文字。真實 POST／GET 標頭差異仍存在，但固定識別讓摘要成功完成。`--legacy-owner` 可重現舊助手來源判斷的失敗。副本只在測試設定檔授權 loopback，不修改正式 manifest 或日常瀏覽器權限。Python HTTP 回歸涵蓋無 Origin 輪詢、不同外掛、Origin 不符、格式不正確、錯誤 token、一般網站拒絕；另覆蓋完成 61 秒後仍可讀、預算後過期。新增前端遺失工作時只提交一次並給出重試說明的測試。

排錯：先在沒有重要工作時重啟本專案 `companion/start.cmd`，重載外掛並重開側欄，再按整理摘要。`/health.inference_client_identity: true` 表示已載入這次助手修正。若仍失敗，只檢查三種請求是否具有同一個識別，不記錄配對碼、原文或完整請求標頭。維護時不能再假設 GET 一定帶 Origin；新增工作端點需一起驗證建立、讀取與取消的身分一致性。

測試指令：`npm.cmd test`、設定 `CHROME_PATH` 後的 `npm.cmd run test:browser`，以及 `companion\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'`。真實外掛傳輸測試以可載入開發外掛的 Chromium 執行 `node tests/inference-origin-smoke.cjs`；此測試只驗證傳輸與狀態，不取代真實模型的語意品質驗收。

本輪驗證：40 項 JavaScript 單元測試、52 項 Python 測試、92 項瀏覽器回歸全數通過；獨立的真實外掛＋正式助手 HTTP 傳輸驗證成功，舊來源判斷模式亦重現失敗。兩份診斷報告分別為 `test-results/inference-origin-smoke.json` 與 `inference-origin-smoke-legacy.json`，不記錄實際配對碼或使用者原文。

## PDF 體驗紀錄（2026-10-30）

原本工作室只顯示籠統處理訊息；取消請求送出後也不容易區分是否已停止。現在以 BabelDOC 0.6.4 已安裝原始碼的 `async_translate()` 事件為依據，將 Parse／Detect 類階段映射為分析、Translate／Extract Terms 為翻譯、Typesetting／Fonts／Drawing／Save 為排版輸出；不認得的階段顯示一般處理中，不猜測進度。OCR 由本工具逐頁處理時回報。只顯示「本階段 X / Y」，單位可能是段落、字型或頁，不能稱為整份文件百分比。

資料流：工作室「試翻前 2 頁」或完整翻譯 → `POST /pdf?preview=true/false` → `app.py/start_pdf()` 驗證 PDF、頁數、語言與資源 → 試翻先用 PyMuPDF 實際裁出前一至兩頁 → `input.pdf` 與私有 `options.json` → 隔離 `pdf_worker.py` → `pdf_progress.py` 只寫白名單階段與整數的 `progress.json` → 助手每 0.3 秒讀取 → 工作室每 3 秒查 `/jobs` 顯示。原文、檔案路徑及引擎原始事件不會寫入進度訊息。

試翻忽略指定頁碼欄位，明確只處理原檔前兩頁，原檔不足兩頁則全部。實際裁切可同時限制 OCR 與排版分析，而不是只限制送翻譯的頁數。原檔仍會上傳至本機助手，並保留原來 64 MB／500 頁限制；上傳前也不解析頁數。`/health.pdf_preview: true` 才啟用試翻，避免舊助手忽略新參數、意外處理整份文件。完整翻譯按鈕維持既有指定頁碼功能。

取消：`DELETE /jobs/{id}` 設取消事件與 cancelling 階段，工作仍維持 running／queued，以防清理程序誤刪；父程序終止工作程序並等待退出，再更新 cancelled。工作室禁用重複取消按鈕，取消後可手動清除暫存。此確認代表 PDF 工作程序已結束；已送往相容模型 API 的推論仍可能繼續，不保證整個 Ollama 立即閒置。助手意外中斷後恢復為 failed，移除過時的階段計數。

完成檢查：必須收到引擎 finish、未收到 error，且存在非空 PDF；殘留輸出不能算成功。實測第一份過於稀疏的人工頁面被 BabelDOC 判為掃描文件，已保留判定並新增明確提示，沒有停用偵測。掃描模式仍限定英文白底黑字。若原檔可選文字卻被上游判為掃描，可先試不同頁碼、核對文字層，避免直接放寬完成規則。

驗證：39 項 JavaScript、50 項 Python、92 項瀏覽器測試通過，包含預覽強制兩頁、單頁、掃描文件裁切、只在後頁有文字的情況、事件白名單、錯誤不視為完成、取消狀態及舊助手防護。`tests/integration_pdf_preview.py --live` 使用人工三頁 PDF、目前 Gemma 3 4B、暫時助手／工作資料與既有排版資源，第一次成功實測 94.172 秒，觀察到 analysis／translation／output／done；兩份輸出各兩頁。另驗證啟動階段取消會等到程序不存在才通過，這不等於已測過翻譯中取消後的模型釋放時間。掃描路徑本輪以裁切與階段測試覆蓋，未重做真實 OCR 品質驗收。

排錯：試翻按鈕停用先重啟新版助手再重新檢查連線；階段長時間停在翻譯則檢查模型，停在分析／OCR／輸出則先用兩頁縮小範圍。進度屬於抽樣，短暫階段可能在兩次輪詢間完成；不要以未看到某階段判斷它一定沒執行。先等 cancelled 再清除；檔案與配對資料仍遵循既有保存與清理規則。

維護例：升級 BabelDOC 時，須先核對 `async_translate` 事件與名稱，更新 `event_phase()` 白名單及 worker 的版本檢查，再重跑真實人工 PDF。要增加試翻頁數，需一起修改助手實際裁切、pages 選項、前端文案／標籤、測試及 capability 定義，不能只改按鈕文字。更新本輪需重載外掛／重開工作室，並在沒有重要工作時重啟 `companion/start.cmd`。

正式 worker 最後一次重驗（未使用診斷包裝）：84.250 秒，兩份輸出各兩頁，共擷取 950 個中文字；已渲染並人工檢視測試第一頁，確認可讀。啟動階段取消確認 0.015 秒。報告 `test-results/pdf-preview-integration.json`、頁面 `test-results/pdf-preview-page.png` 均為人工樣本且排除於 Git；這些數值不是實際文件的速度保證，也不是表格、公式或 OCR 全面驗收。

## 語音字幕紀錄（2026-10-30）

先量測再調整：使用既有人工語音測試樣本前 4.5 秒、隔離助手資料與目前 Gemma 3 4B，不修改正式設定、不錄製使用者音訊，也未下載模型。Whisper small 首次辨識含載入 6.422 秒、第二次 2.282 秒；這次首筆文字翻譯 10.031 秒。第二次辨識＋首筆翻譯合計 12.313 秒，超過 4 秒輸入步距；不能把這個混合首筆與暖辨識的樣本當作穩態吞吐量。它證明這次工作來不及逐段完整處理；延長佇列只會增加落後。`tests/benchmark_speech.py --live` 可重測，輸出 `test-results/speech-benchmark.json`，不把此單機單樣本推廣到其他電腦、模型或內容。

原本音訊四秒硬切、忙碌就略過；現在每四秒送出一個 4.5 秒視窗，與前一窗共用 0.5 秒，首次需累積 4.5 秒。`audio-worklet.js` 混音並降至 16 kHz，保留最後 0.5 秒供下次使用。`speech-state.js/POLICY` 記錄對應政策，`createLatestBuffer()` 只留最新一段等候；被覆蓋的舊段不會累積。最多同時一段處理、一段等待（約 576 KB Float32 音訊，不含 WAV 編碼暫存），音訊不寫磁碟。

資料流：分頁音訊 → AudioContext／AudioWorklet → `{samples, sequence, overlapMs}` → `video.js/speech()` 立即記錄擷取完成時間與播放時間線 → 最新一段緩衝 → `drainSpeech()` 再驗證播放位置 → `/speech` 的 Whisper → 保守重疊文字去除 → 所選 Chrome／本機翻譯器 → `media-show` 再驗證時間線並整段顯示。

保守去重僅限連續序號、同一時間線、約四秒播放進度，且辨識首段從重疊範圍內開始；只刪除前段尾端與新段開頭完全匹配的 3～12 個空白分隔詞，忽略大小寫與詞邊標點。跳過片段、快轉、暫停或空白辨識會中斷連續性。這不是語意校正，無空白分詞語言不做字元猜測，也不保證消除所有重複或邊界漏字。

等待超過 6 秒的音訊不送辨識；距擷取完成超過 15 秒的結果不再送翻譯／顯示。側欄顯示最近一次完成流程的辨識、翻譯耗時及是否超過四秒；略過計數包含緩衝覆蓋、過期與時間線失效，不代表漏掉的所有字數。`watchSpeech()` 每 250 ms 檢查播放時間線，改變時送 reset 清空 worklet 緩衝、待處理音訊與文字去重紀錄，避免把快轉前後聲音混成一段。停止會關閉音訊軌及清空等待，已在助手辨識中的 Whisper 仍可能運算到結束，晚到結果會丟棄。

驗證包括 16／44.1／48 kHz 的精確音訊重疊、四秒步距、快轉清空、有限緩衝與過期、條件去重，以及瀏覽器控制流程的最新段落、跳段後不誤刪、時間線變更與停止。瀏覽器音訊擷取及模型回應為模擬，真實 Whisper／Gemma 只驗證人工樣本的階段耗時；尚未驗收真實網站音訊、廣告、背景音樂與不同語言品質。

排錯：若辨識快而翻譯慢，先看所選引擎，可手動改較快的 Chrome 語言包；若首次辨識慢、後續恢復，可能是模型載入。大量略過表示處理跟不上，避免增加佇列。重複文字先看序號是否連續及首段 start 是否位於 0.5 秒內；不符合條件就保留原辨識，避免刪錯。修改範例：要調重疊長度，同步 `audio-worklet.js` 的視窗／保留樣本、送出 metadata、`speech-state.js/POLICY`、`video.js` 的樣本驗證、畫面提示及測試；重疊增加會提高辨識成本，須重新量測。

本輪未改助手。更新需重載外掛、重新整理影片並重開側欄；新 worklet 與控制器必須一起載入。

Worklet 每次清空亦更新 `epoch`（音訊世代編號），控制器在讀取播放狀態前後都檢查，拒絕清空前已送出卻較晚抵達的音訊訊息。這避免只清記憶體卻仍處理舊訊息的競速問題。

本輪最終驗證：39 項 JavaScript 單元測試、90 項瀏覽器流程全部通過；助手正式程式未修改，Python 回歸不重跑。人工音訊的真實 Whisper 與本機模型量測獨立記錄於上方，不能用模擬瀏覽器測試替代真實音訊品質驗收。

## 長網頁擷取紀錄（2026-10-30）

原先 `content.js/allowed()` 針對每個文字節點重新檢查整條祖先鏈，排序也反覆讀取同一段落位置。現在 `readContext()` 建立 WeakMap（不延長網頁元素生命週期的對照表），重用祖先樣式判斷、排除規則、文字元素矩形與排序位置。快取只屬於這次擷取的一批工作；每次讓出執行時間後及送出前驗證時都重建，`apply()` 也使用新的檢查資料，避免舊樣式讓隱藏內容被翻譯。

流程：`qingread:collect`／`qingread:summary-source` → 選正文範圍 → TreeWalker 逐一讀文字節點、共用這批可見性快取 → 每 512 節點讓瀏覽器處理其他工作 → 檢查工作序號及頁面變更 → 合併段落並依位置排序（摘要保留原文順序）→ 以新快取重新驗證 → 回覆。Chrome 訊息處理器會保持回覆通道直到非同步擷取結束；25,000 節點、200 段及 60,000 字元上限維持原規則。

讓出執行時間後，網頁可能已改變。MutationObserver 監看結構、文字及屬性變動，工作序號防止取消或新工作後舊擷取繼續；不一致時回覆 `error: changed`，側欄顯示頁面變動錯誤並要求重試，不送部分新舊混合文字給模型。取捨是持續改動 DOM 的頁面可能需要等畫面穩定後重試；目前採保守的整頁變更判斷。

基準：300 段、每段 10 個 span、8 層共同容器的人工頁面，既有程式 39,013 次樣式檢查、154.6 ms、計時器執行 0 次；新版單獨測量 5,595 次、65.7 ms、計時器執行 5 次。樣式檢查約減少 86%，耗時是單次本機數字，會隨硬體、網站與同時執行的工作變動。報告寫到被排除的 `test-results/extraction-benchmark.json`，回歸測試以檢查次數及能否讓出執行時間為門檻，不用容易波動的毫秒數判斷成功。

新增 `tests/long-page.test.cjs` 覆蓋擷取上限與順序、祖先隱藏後拒絕插入、重新顯示及新增文字、擷取途中取消／變更。既有一般頁、Google、Wikipedia、Skilljar、選取範圍與摘要測試一併回歸。測試指令仍為 `npm.cmd test` 及設定 `CHROME_PATH` 後的 `npm.cmd run test:browser`；本輪助手未修改，無需重跑 Python 或重啟助手。

排錯：若頁面變動提示反覆出現，先停止自動更新或等待頁面穩定後重試，再跑長頁測試。若下一次擷取漏掉新內容，檢查是否把 `readContext()` 移到全域；快取不可跨擷取保留。維護例：要調整每批 512 節點，可修改 `collect()` 中的批次條件，並驗證瀏覽器計時器仍能執行、取消仍有效、隱藏內容與選取範圍不洩漏。批次越小通常越容易回應操作，但會增加排程等待。

本輪最終驗證：36 項 JavaScript 單元測試、88 項瀏覽器測試全部通過。Python 助手未修改；先前 43 項通過的紀錄保留，這輪不重複計為新測試結果。

## 這輪設計與資料流

`text.js`／`panel.js`／`summary.js`／`video.js`
→ `local-client.js/runInference()` 建立隨機工作 ID
→ `POST /inference/{id}` 建立工作，`GET` 每 250 ms 讀狀態
→ `app.py/start_inference()` 驗證輸入、擷取所選模型、建立指令
→ `inference.py/InferenceJobs` 有限佇列、共用模型通道、180 秒截止時間
→ 比對模型指紋與記憶體快取
→ `ModelStream` 連線固定 `127.0.0.1:11434/api/chat`
→ 驗證完整結果、繁中轉換、清理連線、釋放通道後回報完成。

停止：瀏覽器取消訊號 → `DELETE /inference/{id}` → 助手標記 cancelling、shutdown 該筆模型 socket → 工作執行緒完成清理並釋放 semaphore（一次只允許一筆推論的通道）→ cancelled。DELETE 早於建立抵達時保留短期取消標記，避免工作之後偷偷啟動。前端最多等 3 秒確認取消；無法確認時如實提示，助手仍有自己的截止時間。

工作最多 8 筆排隊／執行，登錄最多 256 筆；完成結果僅留記憶體，180 秒後在存取或每 5 秒背景清理時移除。快取最多 32 筆／512,000 bytes／600 秒，保存結果與雜湊鍵，不保存原文檔。沒有可用 digest（模型內容指紋）就跳過快取；更新同名模型、換來源語言或推論指令會失效，修改模型設定也清空。台灣用語與自訂詞彙表在前端套用，因此可安全重用轉換前的結果。

接續：`text.js` 在側欄記憶體保存原文、已完成區塊、設定快照及模型身分 →「接續翻譯」跳過已完成區塊 → `expectedModelIdentity` 送助手再次檢查。同名模型更新也會拒絕混用。重新開始會重翻全文；清空、修改原文或關閉側欄會失去接續資料。

## 驗證與實測

- `npm.cmd test`：36 項單元測試通過。
- `companion\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'`：43 項通過。
- 瀏覽器完整測試：85 項通過。
- `tests/benchmark_inference.py --live`：人工原文、目前 Gemma 3 4B，使用隔離助手資料。首筆 10.266 秒、取消確認 0.015 秒、後續不同原文 3.375 秒、重複原文命中快取 0.157 秒。報告在被版控排除的 `test-results/inference-benchmark.json`；需重新測量時可執行同一支腳本，會使用目前設定的模型，不更改正式設定。
- 測試覆蓋尚無首字、已開始串流、排隊取消、建立與取消競速、逾時、清理前不釋放通道、身分隔離、TTL／容量／模型更新、失敗不快取，以及接續翻譯與設定變動。

## 更新與排錯

1. 重載外掛、重新整理影片並重開側欄。
2. 助手本輪有修改，需在沒有重要工作進行時關閉原助手，再執行 `companion/start.cmd`。不要刪除 `companion/data/config.json`，它含個人設定與配對碼。
3. `/health` 的 `inference_jobs: true` 代表新工作功能已載入。看到「請重新啟動新版助手」先確認執行的是本專案助手；磁碟有新程式不代表舊程序已更新。
4. 長時間排隊：檢查是否有 PDF 或其他推論占用共用通道。一直 cancelling：檢查 Ollama 與助手連線，不可把狀態直接改 cancelled 來隱藏未清理的工作。
5. 接續提示模型變更：重新翻譯全文；需要保留舊部分結果時先複製。
6. 回復舊程式前先停止工作，再以 Git 查看差異並還原需要的檔案；維持外掛與助手版本相容。不使用 `git reset --hard` 或 `git clean` 處理日常排錯。

維護例：調整快取容量需同時修改 `app.py` 的筆數／bytes／TTL、失效測試及本文件。調整 180 秒預算需同步 `inference.py/TIMEOUT_SECONDS` 和 `local-client.js/TIMEOUT_MS`，既有測試會比對。修改串流或取消時，必須驗證模型首字之前也能取消，且取消確認出現前通道仍被占用。

## Git 使用方式

GitHub 遠端為 `https://github.com/tivico/qingread.git`，`main` 用於保存原始碼與文件；提交後需推送成功才會出現在 GitHub。模型、配對設定與個人文件不在儲存庫內，需自行另外保管。第一筆提交只保存當時基準，無法回溯建立版控前的程式版本。

```powershell
git status --short
git diff
git log --oneline -5
git add extension/text.js README.md CHANGELOG.md docs/PROGRESS.md
git diff --cached
git commit -m "說明這次行為變更"
```

每次修改先看差異，再跑受影響測試，更新 CHANGELOG 與本文件，最後提交。`companion/data`、`.venv`、模型、`output`、測試結果與打包檔均排除；若新增個人文件目錄，先補 `.gitignore` 再加入 Git。不要為了方便而強制加入被排除的配對設定或文件。
