// Render with the production ScriptManager, not a second template engine.
const fs=require('fs'), path=require('path');
const {ScriptManager}=require('../dist/script-manager');
const {WATCHER_VERSION}=require('../dist/protocol');
const manager=new ScriptManager();
const output=process.argv[2];
fs.mkdirSync(output,{recursive:true});
const params={PROJECT_FILE_PATH:'C:/中文/工程.project',PATTERN:'去核|中文轴',USE_REGEX:'1',CASE_SENSITIVE:'1',INCLUDE_DECL:'1',INCLUDE_IMPL:'1',MAX_HITS:'10'};
const fixtures={
  search:manager.prepareScriptWithHelpers('search_code',params,['_text_utils']),
  bulk:manager.prepareScriptWithHelpers('get_all_pou_code',{PROJECT_FILE_PATH:params.PROJECT_FILE_PATH},['_text_utils']),
  watcher:manager.prepareScript('watcher',{IPC_BASE_DIR:output,SESSION_TOKEN:'fixture',WATCHER_VERSION}),
};
fs.writeFileSync(path.join(output,'fixtures.json'),JSON.stringify(fixtures),'utf8');
