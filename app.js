import { VERSION, G0, COLUMNS, motionRow, noteRow, csvLine, exportName, validMotion } from './core.js';

const $=id=>document.getElementById(id);
const MAX_MS=30*60*1000, MAX_PENDING=2000;
let db=null, current=null, active=false, finishing=false, broken=false, busy=false;
let refreshTimer=null, demoTimer=null, wake=null, fileURL=null, exportFile=null;
let lastRateCount=0, lastRateTime=0;
const statuses={saved:'保存済み',interrupted:'中断',sensor_timeout:'センサー停止',storage_error:'保存エラー',recording:'未終了・回収可能',waiting:'未終了・回収可能'};

function status(text,detail,tone='') {
  $('statusText').textContent=text; $('statusDetail').textContent=detail;
  $('statusDot').className='dot'+(tone?' '+tone:'');
}
function lockControls(locked) {
  $('startButton').disabled=locked || !db || broken;
  $('stopButton').disabled=!active || finishing;
  $('markButton').disabled=!active || finishing;
  $('demoMode').disabled=locked; $('mountNote').disabled=locked;
}
function openDB() {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('stagevector-motion-v1',1);
    request.onupgradeneeded=()=>{
      const d=request.result;
      d.createObjectStore('sessions',{keyPath:'id'});
      const chunks=d.createObjectStore('chunks',{keyPath:['session','index']});
      chunks.createIndex('session','session');
    };
    request.onerror=()=>reject(request.error);
    request.onblocked=()=>reject(new Error('保存先が別タブで使用されています。'));
    request.onsuccess=()=>resolve(request.result);
  });
}
function transaction(stores,write,body) {
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(stores,write?'readwrite':'readonly');
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error || new Error('保存に失敗しました。'));
    tx.onabort=()=>reject(tx.error || new Error('保存を中断しました。'));
    try { body(tx); } catch(error) { tx.abort(); reject(error); }
  });
}
async function persist(r) {
  if(r.pendingWrite) return r.pendingWrite;
  if(r.storageFailed) throw new Error('端末内保存は停止しています。');
  const batch=r.buffer.splice(0), index=r.chunkIndex;
  const sampleCount=batch.filter(row=>row[0]==='SAMPLE').length;
  const snapshot={...r.meta,count:r.persisted+sampleCount};
  r.pendingWrite=transaction(['sessions','chunks'],true,tx=>{
    if(batch.length) tx.objectStore('chunks').put({session:r.meta.id,index,rows:batch});
    tx.objectStore('sessions').put(snapshot);
  }).then(()=>{
    r.persisted+=sampleCount; if(batch.length) r.chunkIndex++;
    $('storageText').textContent=`端末内保存 ${r.persisted.toLocaleString()}件`;
  }).catch(error=>{
    r.buffer.unshift(...batch); r.storageFailed=true; throw error;
  }).finally(()=>{r.pendingWrite=null;});
  return r.pendingWrite;
}
function eventNote(r,label,extra={}) {
  r.buffer.push(noteRow(r.meta,'EVENT',JSON.stringify({event:label,...extra}),performance.now(),Date.now()));
}
async function releaseWake() {
  if(wake) { const old=wake; wake=null; try { await old.release(); } catch {} }
  $('wakeText').textContent='画面維持：終了';
}
async function requestWake() {
  if(!navigator.wakeLock) { $('wakeText').textContent='画面維持：非対応'; return; }
  try {
    wake=await navigator.wakeLock.request('screen');
    if(!active) { await releaseWake(); return; }
    $('wakeText').textContent='画面維持：有効';
    wake.addEventListener('release',()=>{
      if(active) { $('wakeText').textContent='画面維持：解除'; eventNote(current,'WAKE_RELEASE'); }
    });
  } catch(error) {
    $('wakeText').textContent='画面維持：利用不可';
    if(active) eventNote(current,'WAKE_REJECT',{name:error.name});
  }
}
function getAngle() {
  return typeof screen.orientation?.angle==='number' ? screen.orientation.angle :
    typeof window.orientation==='number' ? window.orientation : null;
}
function accept(event) {
  const r=current;
  if(!active || !r) return;
  const now=performance.now(), wall=Date.now();
  const row=motionRow(event,r.meta,r.meta.count+1,now,wall,getAngle());
  if(!validMotion(row)) { r.meta.emptyEvents++; return; }
  if(r.lastSample!=null) {
    const dt=now-r.lastSample;
    r.meta.maxGapMs=Math.max(r.meta.maxGapMs,dt);
    if(dt>100) { r.meta.gapCount++; eventNote(r,'SAMPLE_GAP',{gap_ms:dt}); }
    if(dt>0) r.meta.intervalSumMs+=dt;
  }
  r.lastSample=now;
  if(row.slice(9,12).every(v=>v!==null)) r.meta.accelSamples++;
  if(row.slice(15,18).every(v=>v!==null)) r.meta.rotationSamples++;
  r.meta.count++; r.meta.state='recording'; r.latest=row;
  r.buffer.push(row);
  if(r.buffer.length>MAX_PENDING) void finish('storage_error','保存待ちデータが上限に達しました。');
}
function displayLatest(r) {
  if(!r.latest) return;
  const row=r.latest;
  for(const [id,n,scale,places] of [['ax',9,G0,2],['ay',10,G0,2],['az',11,G0,2],['ra',15,1,1],['rb',16,1,1],['rg',17,1,1]])
    $(id).textContent=row[n]===null?'—':(row[n]/scale).toFixed(places);
}
function refresh() {
  const r=current;
  if(!r) return;
  const now=performance.now(), elapsed=now-r.meta.startMono;
  const sec=Math.floor(elapsed/1000);
  $('elapsed').textContent=`${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;
  $('count').textContent=r.meta.count.toLocaleString(); displayLatest(r);
  if(now-lastRateTime>=1000) {
    $('rate').textContent=((r.meta.count-lastRateCount)*1000/(now-lastRateTime)).toFixed(1);
    lastRateCount=r.meta.count; lastRateTime=now;
    if(active && !r.pendingWrite) void persist(r).catch(error=>finish('storage_error',error.message));
  }
  if(!active) return;
  const silence=now-(r.lastSample ?? r.meta.startMono);
  if(silence>5000) { void finish('sensor_timeout',r.meta.count?'5秒間データを受信できませんでした。':'センサー値を取得できませんでした。許可と端末の対応を確認してください。'); return; }
  if(elapsed>=MAX_MS) { void finish('saved','30分の上限に達して停止しました。'); return; }
  if(r.meta.source==='SIM') status('模擬データを記録中','SIMです。実車センサーの計測結果ではありません。');
  else if(silence>1000) status('センサー応答待ち','値が止まっています。空白を残し、5秒で停止します。');
  else if(r.latest) status('計測中','Safariを前面にしたままにしてください。','active');
}
async function start() {
  if(active || busy || finishing || !db || broken) return;
  busy=true; lockControls(true);
  const demo=$('demoMode').checked;
  try {
    status('開始準備','センサーの利用許可を確認しています。');
    if(!demo) {
      if(!window.isSecureContext) throw new Error('HTTPSのURLをSafariで開いてください。');
      if(!window.DeviceMotionEvent) throw new Error('このブラウザーは動作センサーに対応していません。');
      // Keep this call in the button's user activation, before other awaits.
      if(typeof DeviceMotionEvent.requestPermission==='function') {
        const permission=await DeviceMotionEvent.requestPermission();
        if(permission!=='granted') throw new Error('動作センサーの許可が得られませんでした。Safariのサイト設定を確認してください。');
      }
    }
    if(document.visibilityState!=='visible') throw new Error('このページを前面にして開始してください。');
    const now=performance.now(), epoch=Date.now();
    const random=crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint32Array(4)),n=>n.toString(16).padStart(8,'0')).join('');
    current={meta:{id:random,version:VERSION,source:demo?'SIM':'SENSOR',startEpoch:epoch,startMono:now,
      timeOrigin:performance.timeOrigin,state:'waiting',mountNote:$('mountNote').value.trim(),
      screenAngleStart:getAngle(),count:0,gapCount:0,maxGapMs:0,intervalSumMs:0,markers:0,
      accelSamples:0,rotationSamples:0,emptyEvents:0},
      buffer:[],chunkIndex:0,persisted:0,pendingWrite:null,storageFailed:false,lastSample:null,latest:null};
    const r=current;
    eventNote(r,'START',{source:r.meta.source});
    await persist(r);
    active=true; lastRateCount=0; lastRateTime=now;
    $('exportActions').hidden=true; $('exportHint').hidden=true;
    $('elapsed').textContent='00:00'; $('count').textContent='0'; $('rate').textContent='—';
    $('markButton').textContent='マーカーを追加';
    for(const id of ['ax','ay','az','ra','rb','rg']) $(id).textContent='—';
    window.addEventListener('devicemotion',onMotion);
    refreshTimer=setInterval(refresh,100);
    if(demo) demoTimer=setInterval(()=>{
      const t=(performance.now()-now)/1000;
      accept({timeStamp:performance.now(),interval:20,acceleration:{x:Math.sin(t)*2,y:Math.cos(t*.7),z:.1*Math.sin(t*2)},
        accelerationIncludingGravity:{x:Math.sin(t)*2,y:Math.cos(t*.7),z:G0+.1*Math.sin(t*2)},
        rotationRate:{alpha:Math.sin(t*.7)*25,beta:Math.cos(t)*3,gamma:Math.sin(t)*4}});
    },20);
    status(demo?'模擬データを記録中':'センサー応答待ち',demo?'SIMです。実測データではありません。':'許可済み。最初の値を待っています。');
    void requestWake();
  } catch(error) {
    status('開始できません',error.message,'error');
  } finally { busy=false; lockControls(active || finishing); }
}
function onMotion(event) { if(current?.meta.source==='SENSOR') accept(event); }
async function finish(reason='saved',detail='停止しました。') {
  if(!active || finishing) return;
  finishing=true; active=false; lockControls(true);
  clearInterval(refreshTimer); clearInterval(demoTimer);
  window.removeEventListener('devicemotion',onMotion);
  const r=current;
  r.meta.endEpoch=Date.now(); r.meta.durationUs=Math.round((performance.now()-r.meta.startMono)*1000);
  r.meta.state=reason; r.meta.endDetail=detail;
  eventNote(r,'STOP',{reason,detail});
  status('保存中','端末内への保存を完了させています。');
  await releaseWake();
  try {
    if(r.pendingWrite) await r.pendingWrite;
    if(r.storageFailed) throw new Error('端末内保存に失敗したデータが残っています。');
    await persist(r);
    status(reason==='saved'?'停止・端末内保存済み':'中断・端末内保存済み',detail+' CSVを書き出してください。',reason==='saved'?'':'error');
  } catch(error) {
    broken=true; r.meta.state='storage_error'; r.meta.endDetail=error.message;
    status('保存エラー',error.message+' このページを閉じずにCSVを回収してください。','error');
  }
  finishing=false; lockControls(false); refresh();
  await listSessions();
  if(document.visibilityState==='visible') await prepareExport(r.meta.id);
}
async function readSession(id) {
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('sessions','readonly'), req=tx.objectStore('sessions').get(id);
    req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
  });
}
async function prepareExport(id) {
  if(busy || finishing || (active && current?.meta.id===id)) return;
  busy=true; lockControls(active); $('exportHint').hidden=false; $('exportHint').textContent='CSVを用意しています…';
  try {
    const r=current?.meta.id===id?current:null;
    if(r?.pendingWrite) try { await r.pendingWrite; } catch {}
    const meta=r?{...r.meta}:await readSession(id);
    if(!meta) throw new Error('記録が見つかりません。');
    const parts=['\ufeff',csvLine(COLUMNS)];
    parts.push(csvLine(noteRow({...meta,count:0},'META',JSON.stringify({version:meta.version,mountNote:meta.mountNote,
      start_iso:new Date(meta.startEpoch).toISOString(),time_origin_ms:meta.timeOrigin,
      acceleration_unit:'m/s^2',rotation_unit:'deg/s',axes:'native_device',sync:'waveform_alignment_required'}),meta.startMono,meta.startEpoch)));
    let exported=0, lastRowUs=0;
    await new Promise((resolve,reject)=>{
      const tx=db.transaction('chunks','readonly');
      const req=tx.objectStore('chunks').index('session').openCursor(IDBKeyRange.only(id));
      req.onsuccess=()=>{
        const cursor=req.result;
        if(!cursor) return;
        for(const row of cursor.value.rows) {
          if(row[0]==='SAMPLE') exported++;
          lastRowUs=Math.max(lastRowUs,row[4] || 0);
        }
        parts.push(cursor.value.rows.map(csvLine).join('')); cursor.continue();
      };
      req.onerror=()=>reject(req.error); tx.oncomplete=resolve;
      tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error);
    });
    if(r?.buffer.length) {
      parts.push(r.buffer.map(csvLine).join(''));
      for(const row of r.buffer) { if(row[0]==='SAMPLE') exported++; lastRowUs=Math.max(lastRowUs,row[4] || 0); }
    }
    const durationUs=Math.max(meta.durationUs || 0,lastRowUs);
    const exportMeta={...meta,count:exported,durationUs};
    parts.push(csvLine(noteRow(exportMeta,'SUMMARY',JSON.stringify({...exportMeta,reportedCount:meta.count,exportedSamples:exported,
      cleanStop:meta.state==='saved' && meta.count===exported,meanIntervalMs:meta.count>1?meta.intervalSumMs/(meta.count-1):null,
      statusLabel:statuses[meta.state] || meta.state}),meta.startMono+durationUs/1000,meta.endEpoch ?? meta.startEpoch+durationUs/1000)));
    if(fileURL) URL.revokeObjectURL(fileURL);
    exportFile=new File(parts,exportName(meta),{type:'text/csv;charset=utf-8'});
    fileURL=URL.createObjectURL(exportFile);
    $('downloadLink').href=fileURL; $('downloadLink').download=exportFile.name;
    $('exportActions').hidden=false;
    $('shareButton').hidden=!(navigator.canShare && navigator.canShare({files:[exportFile]}));
    $('exportHint').textContent=`${meta.source==='SIM'?'模擬':'実測'} ${exported.toLocaleString()}件。CSVを「ファイル」に保存してください。`;
  } catch(error) {
    $('exportHint').textContent='CSVを用意できません：'+error.message;
  } finally { busy=false; lockControls(active); }
}
async function listSessions() {
  if(!db) return;
  try {
    const records=await new Promise((resolve,reject)=>{
      const req=db.transaction('sessions','readonly').objectStore('sessions').getAll();
      req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
    });
    $('sessions').replaceChildren();
    if(!records.length) { $('sessions').textContent='まだ記録はありません。'; return; }
    for(const record of records.sort((a,b)=>b.startEpoch-a.startEpoch)) {
      const card=document.createElement('div'); card.className='session-card';
      const info=document.createElement('div'); info.className='session-info';
      const title=document.createElement('div'); title.className='session-title';
      title.textContent=`${record.source==='SIM'?'SIM / 模擬':'SENSOR / 実測'} · ${new Date(record.startEpoch).toLocaleString()}`;
      const sub=document.createElement('div'); sub.className='session-subtitle';
      sub.textContent=`${record.count.toLocaleString()}件 · ${statuses[record.state] || record.state}${record.mountNote?' · '+record.mountNote:''}`;
      info.append(title,sub);
      const button=document.createElement('button'); button.textContent='CSVを用意';
      button.disabled=active && current?.meta.id===record.id;
      button.addEventListener('click',()=>{void prepareExport(record.id); $('exportActions').scrollIntoView({block:'center',behavior:'smooth'});});
      card.append(info,button); $('sessions').append(card);
    }
  } catch(error) { $('sessions').textContent='記録一覧を読めません：'+error.message; }
}

$('startButton').addEventListener('click',()=>void start());
$('stopButton').addEventListener('click',()=>void finish());
$('markButton').addEventListener('click',()=>{
  if(!active) return;
  eventNote(current,'MARK',{number:++current.meta.markers});
  $('markButton').textContent=`マーカー ${current.meta.markers} を追加済み`;
});
$('refreshButton').addEventListener('click',()=>void listSessions());
$('demoMode').addEventListener('change',()=>{$('startButton').textContent=$('demoMode').checked?'模擬記録を開始':'計測を開始';});
$('shareButton').addEventListener('click',async()=>{
  if(!exportFile) return;
  try { await navigator.share({files:[exportFile],title:'StageVector Motion CSV'}); }
  catch(error) { if(error.name!=='AbortError') $('exportHint').textContent='共有できません。CSVを保存から回収してください。'; }
});
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='hidden' && active) void finish('interrupted','画面ロックまたは別アプリへの切替で中断しました。');
});
window.addEventListener('pagehide',()=>{if(active) void finish('interrupted','ページを離れたため中断しました。');});
window.addEventListener('beforeunload',event=>{
  if(active || finishing || (current?.storageFailed && current.buffer.length)) { event.preventDefault(); event.returnValue=''; }
});
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible' && !active && !finishing) void listSessions();
});

try {
  db=await openDB();
  db.onversionchange=()=>{db.close(); broken=true; lockControls(active); if(active) void finish('storage_error','保存先が別タブで変更されました。');};
  status('計測待機','iPhoneを固定し、開始ボタンから動作センサーを許可してください。');
  $('storageText').textContent='端末内保存：利用可能'; lockControls(false); await listSessions();
} catch(error) {
  broken=true; status('保存先を使えません','通常のSafariで開き直してください。'+error.message,'error');
  $('storageText').textContent='端末内保存：利用不可'; lockControls(false);
}
