let stream = null;
let recorder = null;
let socket = null;
let sequence = 0;
let rotationTimer = null;
let generation = 0;
let captureSendQueue=Promise.resolve();

async function config() {
  const value = await chrome.storage.local.get(["bridgeUrl", "bridgeToken"]);
  return { url: String(value.bridgeUrl || "").trim().replace(/\/$/, ""), token: String(value.bridgeToken || "").trim() };
}

function notify(active, extra={}) { chrome.runtime.sendMessage({ type:"capture_state", active, ...extra }).catch(()=>{}); }
function sendJson(value) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); }

async function connectCaptureSocket() {
  const {url,token}=await config();
  if(!url||!token) throw new Error("Bridge URL or token is missing");
  const wsUrl=url.replace(/^https:/,"wss:").replace(/^http:/,"ws:")+`/capture?token=${encodeURIComponent(token)}`;
  socket=new WebSocket(wsUrl);
  socket.binaryType="arraybuffer";
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=()=>reject(new Error("Capture WebSocket failed"));});
  socket.onmessage=event=>{try{const msg=JSON.parse(event.data);if(msg.type==="capture_stop")stopCapture();}catch{}};
  socket.onclose=()=>{if(stream) setTimeout(()=>connectCaptureSocket().then(()=>{sendJson({type:"capture_state",active:true,mimeType:recorder?.mimeType,audio:stream?.getAudioTracks().length>0});}).catch(()=>stopCapture()),1000);};
}

async function startCapture(streamId) {
  stopCapture();
  stream=await navigator.mediaDevices.getUserMedia({
    video:{mandatory:{chromeMediaSource:"desktop",chromeMediaSourceId:streamId,maxFrameRate:60}},
    audio:{mandatory:{chromeMediaSource:"desktop",chromeMediaSourceId:streamId}}
  }).catch(()=>navigator.mediaDevices.getUserMedia({video:{mandatory:{chromeMediaSource:"desktop",chromeMediaSourceId:streamId,maxFrameRate:60}},audio:false}));
  await connectCaptureSocket();
  const candidates=["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm"];
  const mimeType=candidates.find(type=>MediaRecorder.isTypeSupported(type))||"";
  function startRecorder() {
    if (!stream || socket?.readyState !== WebSocket.OPEN) return;
    const currentStream=stream, currentSocket=socket, currentGeneration=++generation;
    const current=new MediaRecorder(currentStream,mimeType?{mimeType,videoBitsPerSecond:4000000}:{videoBitsPerSecond:4000000});
    recorder=current; let chunk=0;
    current.ondataavailable=event=>{
      if (!event.data?.size) return;
      const chunkIndex=chunk++;
      captureSendQueue=captureSendQueue.then(async()=>{
        const payload=await event.data.arrayBuffer();
        if(currentSocket!==socket || currentSocket.readyState!==WebSocket.OPEN)return;
        const settings=currentStream.getVideoTracks()[0]?.getSettings()||{};
        currentSocket.send(JSON.stringify({type:"capture_chunk",mimeType:current.mimeType||mimeType,sequence:sequence++,segment:currentGeneration,segmentStart:chunkIndex===0,bytes:payload.byteLength,at:Date.now(),width:settings.width||0,height:settings.height||0,fps:settings.frameRate||0,audio:currentStream.getAudioTracks().length>0}));
        currentSocket.send(payload);
      }).catch(()=>{});
    };
    current.start(250);
  }
  sequence=0; startRecorder();
  // Each new viewer needs a fresh WebM initialization segment.
  rotationTimer=setInterval(()=>{
    const current=recorder;
    if(!current || current.state!=="recording")return;
    current.addEventListener("stop",startRecorder,{once:true}); current.stop();
  },4000);
  stream.getTracks().forEach(track=>track.addEventListener("ended",stopCapture,{once:true}));
  sendJson({type:"capture_state",active:true,mimeType:recorder.mimeType||mimeType,audio:stream.getAudioTracks().length>0});
  notify(true,{mimeType:recorder.mimeType||mimeType});
  return {ok:true,mimeType:recorder.mimeType||mimeType,audio:stream.getAudioTracks().length>0};
}

function stopCapture() {
  clearInterval(rotationTimer); rotationTimer=null;
  try{if(recorder&&recorder.state!=="inactive")recorder.stop();}catch{}
  try{stream?.getTracks().forEach(track=>track.stop());}catch{}
  sendJson({type:"capture_state",active:false});
  try{socket?.close();}catch{}
  recorder=null;stream=null;socket=null;notify(false);
  return {ok:true};
}

chrome.runtime.onMessage.addListener((message,_sender,sendResponse)=>{
  if(message?.type==="capture_start"){startCapture(message.streamId).then(sendResponse).catch(error=>sendResponse({ok:false,error:String(error?.message||error)}));return true;}
  if(message?.type==="capture_stop"){sendResponse(stopCapture());return false;}
});
