let stream = null;
let recorder = null;
let socket = null;
let sequence = 0;

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
  socket.onclose=()=>{if(stream) setTimeout(()=>connectCaptureSocket().catch(()=>stopCapture()),1000);};
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
  recorder=new MediaRecorder(stream,mimeType?{mimeType,videoBitsPerSecond:8000000}: {videoBitsPerSecond:8000000});
  sequence=0;
  recorder.ondataavailable=async event=>{
    if(!event.data?.size||socket?.readyState!==WebSocket.OPEN)return;
    const payload=await event.data.arrayBuffer();
    sendJson({type:"capture_chunk",mimeType:recorder.mimeType||mimeType,sequence:sequence++,bytes:payload.byteLength,at:Date.now(),width:stream.getVideoTracks()[0]?.getSettings()?.width||0,height:stream.getVideoTracks()[0]?.getSettings()?.height||0,fps:stream.getVideoTracks()[0]?.getSettings()?.frameRate||0,audio:stream.getAudioTracks().length>0});
    socket.send(payload);
  };
  recorder.start(250);
  stream.getTracks().forEach(track=>track.addEventListener("ended",stopCapture,{once:true}));
  sendJson({type:"capture_state",active:true,mimeType:recorder.mimeType||mimeType,audio:stream.getAudioTracks().length>0});
  notify(true,{mimeType:recorder.mimeType||mimeType});
  return {ok:true,mimeType:recorder.mimeType||mimeType,audio:stream.getAudioTracks().length>0};
}

function stopCapture() {
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

