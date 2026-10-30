# 第三方來源與版本

外掛執行期使用本專案 JavaScript；本機助手會安裝下列開源套件。完整版本在 companion/requirements-lock.txt。這份清單是來源交接，不是完整法律或供應鏈稽核。

| 元件 | 角色／上游 |
|---|---|
| BabelDOC 0.6.4 | [PDF 排版](https://github.com/funstory-ai/BabelDOC)，AGPL-3.0；上游與沉浸式翻譯有關聯。授權原文附於 companion/licenses/BabelDOC-AGPL-3.0.txt |
| faster-whisper 1.2.1 | [本機語音辨識](https://github.com/SYSTRAN/faster-whisper)，使用 CTranslate2 與 Whisper 權重 |
| rapidocr-onnxruntime 1.4.4 | [掃描文字辨識](https://github.com/RapidAI/RapidOCR)，內含辨識模型 |
| opencc-python-reimplemented 0.1.7 | [繁簡及詞彙轉換](https://github.com/yichen0831/opencc-python)，OpenCC 的 Python 實作 |
| PyMuPDF 1.26.7 | [PDF 解析與影像圖層](https://github.com/pymupdf/PyMuPDF)，其授權需與整體散布方式一併檢查 |
| Ollama | [本機模型服務](https://github.com/ollama/ollama)，使用者另外安裝；本工具不替換其安裝檔 |
| Breeze2 GGUF | 本次使用電腦既有 hf.co/mradermacher/Llama-Breeze2-8B-Instruct-Text-GGUF:Q8_0，未包入發布套件；模型授權與程式授權是不同事項 |

PDF 資源準備由 BabelDOC 從其設定的 GitHub／Hugging Face 等上游下載模型、字型與字碼表。語音準備下載 Systran/faster-whisper-small。本次模型與資源未包入原始碼 ZIP，親友在自己的電腦準備。

若之後散布包含第三方程式、模型或字型的完整安裝包，應一起保留對應版本來源、授權及必要通知；本次沒有宣稱整個產品可以改為封閉授權。不要只複製 .venv 或模型而省略其來源與授權檔案。

依賴更新流程：修改 requirements.txt → 在獨立環境解析 → 實測一般與掃描 PDF、語音、快取位置 → uv pip check → 更新 requirements-lock.txt → 更新本文件與 README 實測紀錄。固定版本不是漏洞免疫；仍需定期檢查上游變更。
