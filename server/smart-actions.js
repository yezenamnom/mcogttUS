const clean=value=>String(value??"").replace(/\s+/g," ").trim();
const key=value=>clean(value).toLocaleLowerCase();

export function buildSmartActions({page=null,windows=[],task="",usage={}}={}){
  const options=[];
  const add=(label,prompt,source)=>{
    label=clean(label).slice(0,100);prompt=clean(prompt).slice(0,320);
    if(!label||!prompt||options.some(option=>key(option.label)===key(label)))return;
    options.push({label,prompt,source});
  };
  const title=clean(page?.title),url=clean(page?.url);
  const youtube=/^https:\/\/(?:www\.|m\.)?youtube\.com\//i.test(url);
  const settings=windows.some(window=>/settings|الإعدادات|sound|الصوت/i.test(clean(window.title)));
  const target=clean(task).match(/G\s?65B/i)?.[0]||null;
  if(settings){
    add("غيّر مخرج الصوت",`افحص نافذة إعدادات الصوت الحالية، اعرض أجهزة الإخراج، ثم غيّر الجهاز المطلوب${target?` إلى ${target}`:""} بعد التحقق من اسمه.`,"desktop");
    add("اعرض أجهزة الصوت","اعرض خيارات أجهزة إخراج الصوت الظاهرة الآن دون تغيير أي شيء.","desktop");
    add("أغلق نافذة الإعدادات","أغلق نافذة الإعدادات الحالية بعد التحقق من أنها النافذة المقصودة.","desktop");
  }
  if(page&&url){
    if(youtube){
      const query=new URL(url).searchParams.get("search_query");
      if(query)add("ابحث عن نتيجة أخرى",`ابحث في نتائج يوتيوب الحالية عن ${clean(query)} واعرض خيارات تشغيل أخرى.`,"browser");
    }
    const excluded=/^(?:home|shorts|subscriptions|you|history|search|sign in|menu|الرئيسية|بحث|الاشتراكات|المكتبة|تسجيل الدخول|الإعدادات)$/i;
    const candidates=(Array.isArray(page.interactive)?page.interactive:[])
      .filter(item=>item?.tag==="a"&&clean(item.text).length>=5&&clean(item.text).length<=100&&!excluded.test(clean(item.text)))
      .map(item=>clean(item.text));
    const unique=[...new Set(candidates)];
    const taskWords=key(task).split(/\s+/).filter(word=>word.length>=3);
    unique.sort((a,b)=>{
      const score=s=>taskWords.reduce((n,word)=>n+(key(s).includes(word)?2:0),0)+(usage[key(s)]||0);
      return score(b)-score(a);
    });
    for(const label of unique.slice(0,youtube?5:4))
      add(label,`افحص الصفحة الحالية ${title?`«${title}»`:""}، ثم افتح العنصر الظاهر بعنوان «${label}» إذا كان ما زال موجودًا ومطابقًا.`,"browser");
  }
  if(!options.length){
    add("افحص الشاشة الحالية","افحص حالة الشاشة الحالية وحدّد الخطوة التالية المناسبة.","desktop");
    add("اعرض النوافذ المفتوحة","اعرض النوافذ الحالية ثم اقترح الخطوة التالية.","desktop");
  }
  const close=options.findIndex(option=>/^أغلق نافذة/.test(option.label));
  const numbered=options.filter((_,index)=>index!==close).slice(0,8).map((option,index)=>({number:index+1,...option}));
  if(close>=0)numbered.unshift({number:0,...options[close]});
  return {title:title||"الكمبيوتر",url:url||null,observedAt:new Date().toISOString(),options:numbered};
}

export function resolveSmartAction(state,number){
  if(!Number.isInteger(number)||number<0||number>9)throw Error("Option must be a number from 0 to 9");
  const option=state?.options?.find(item=>item.number===number);
  if(!option)throw Error("This numbered option is no longer available; refresh suggestions");
  return option;
}
