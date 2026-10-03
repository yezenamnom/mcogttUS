const status=document.getElementById('status');
async function send(command){const r=await chrome.runtime.sendMessage({type:'use_workspace',command});if(!r?.ok)throw Error(r?.error||'الإضافة غير متاحة');return r.result;}
function handle(id,command){document.getElementById(id).onclick=async()=>{try{status.textContent='جارٍ التنفيذ…';const r=await send(command);status.textContent=r.message||(r.verified?'تم التقسيم والتحقق داخل النافذة نفسها':'لم يُثبت التقسيم');}catch(e){status.textContent=e.message;}};}
handle('chat','use_chat_right');handle('split','use_split_selected');document.getElementById('options').onclick=()=>chrome.runtime.openOptionsPage();
send('use_split_status').then(r=>{status.textContent=r.supported?'التقسيم الأصلي متاح': 'Chrome 153 الحالي: التقسيم من قائمة Comet؛ إنشاء التقسيم من الإضافة غير مدعوم. يمكنك ربط ChatGPT بالموقع هنا.';}).catch(e=>status.textContent=e.message);
