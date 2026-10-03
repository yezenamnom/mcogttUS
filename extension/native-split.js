export async function splitTabs(api,tabs){
 if(tabs.length!==2)throw Error('اختر تبويبين بالضبط بـ Ctrl + النقر على التبويبات ثم افتح الإضافة');
 if(tabs[0].windowId!==tabs[1].windowId)throw Error('اختر تبويبين من النافذة نفسها');
 if(typeof api.tabs.createSplit!=='function')throw Error('NATIVE_SPLIT_API_UNAVAILABLE: هذه النسخة لا تسمح للإضافة بإنشاء التقسيم؛ اختر «فتح في العرض المنقسم» من قائمة Comet. لن تُفتح نافذتان.');
 if(tabs.some(t=>t.splitViewId>=0))throw Error('التبويب مقسّم بالفعل؛ افصل التقسيم الحالي أولًا');
 if(tabs[0].pinned!==tabs[1].pinned||tabs[0].groupId!==tabs[1].groupId)throw Error('يجب أن يكون التبويبان في المجموعة نفسها وبنفس حالة التثبيت');
 if(Math.abs(tabs[0].index-tabs[1].index)!==1)await api.tabs.move(tabs[1].id,{index:tabs[0].index+(tabs[1].index>tabs[0].index?1:0)});
 const splitViewId=await api.tabs.createSplit(tabs.map(t=>t.id));const actual=await Promise.all(tabs.map(t=>api.tabs.get(t.id)));
 return {kind:'native_split',splitViewId,verified:splitViewId>=0&&actual.every(t=>t.splitViewId===splitViewId&&t.windowId===tabs[0].windowId),tabIds:tabs.map(t=>t.id)};
}
