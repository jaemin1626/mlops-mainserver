const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  openFolderDialog: (opts) => ipcRenderer.invoke('openFolderDialog', opts),
  setWorkspaceRoot: (path) => ipcRenderer.invoke('setWorkspaceRoot', path),
  setMediaBaseRoot: (path) => ipcRenderer.invoke('setMediaBaseRoot', path),
  getMediaBaseRoot: () => ipcRenderer.invoke('getMediaBaseRoot'),
  scanFolder: (path) => ipcRenderer.invoke('scanFolder', path),
  readTxt: (path) => ipcRenderer.invoke('readTxt', path),
  writeTxt: (path, content) => ipcRenderer.invoke('writeTxt', path, content),
  openLabelFileDialog: () => ipcRenderer.invoke('openLabelFileDialog'),
  readLabelFile: (path) => ipcRenderer.invoke('readLabelFile', path),
  showItemInFolder: (path) => ipcRenderer.invoke('showItemInFolder', path),
  deleteImageAndTxt: (imagePath, txtPath, jsonPath) =>
    ipcRenderer.invoke('deleteImageAndTxt', imagePath, txtPath, jsonPath),
  deleteImagePolygonJson: (imagePath, jsonPath) => ipcRenderer.invoke('deleteImagePolygonJson', imagePath, jsonPath),
  openJsonFileDialog: () => ipcRenderer.invoke('openJsonFileDialog'),
  saveJsonFileDialog: (defaultPath) => ipcRenderer.invoke('saveJsonFileDialog', defaultPath),
  readJsonFile: (filePath) => ipcRenderer.invoke('readJsonFile', filePath),
  writeJsonFile: (filePath, content) => ipcRenderer.invoke('writeJsonFile', filePath, content),
  ocrInit: (lang, modelPreset, detectOptions) =>
    ipcRenderer.invoke('ocrInit', lang, modelPreset, detectOptions),
  ocrDetectRecognize: (imagePath, lang, detectOptions) =>
    ipcRenderer.invoke('ocrDetectRecognize', imagePath, lang, detectOptions),
  ocrBatchDetect: (imagePaths, lang, detectOptions) =>
    ipcRenderer.invoke('ocrBatchDetect', imagePaths, lang, detectOptions),
  ocrRecognizeQuad: (imagePath, points, lang) => ipcRenderer.invoke('ocrRecognizeQuad', imagePath, points, lang),
});
