(() => {
  // Isolated, click-through activity decoration: never replaces browser safety UI.
  let host=document.getElementById('__gptus_activity_wave');
  if(!host){
    host=document.createElement('div');host.id='__gptus_activity_wave';
    host.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483646';
    host.setAttribute('aria-hidden','true');
    const root=host.attachShadow({mode:'closed'});
    root.innerHTML=`<style>
      .wave{position:absolute;top:0;left:0;right:0;height:5px;opacity:.38;background:linear-gradient(90deg,#8acfff,#b9b8ff,#ffc6df,#aceadd,#8acfff);background-size:200% 100%;animation:flow 3s linear infinite}
      .arrows{position:absolute;top:12px;left:50%;display:flex;gap:7px;transform:translateX(-50%);opacity:.5}
      svg{position:absolute;top:0;left:0;width:100%;height:46px;opacity:.24;overflow:hidden}path{fill:none;stroke-width:3;animation:breathe 2.4s ease-in-out infinite alternate;transform-origin:center}path:nth-of-type(2){animation-delay:-.8s}path:nth-of-type(3){animation-delay:-1.6s}
      @keyframes breathe{to{transform:translateY(6px) scaleY(.7);opacity:.55}}
      span{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;color:#4679a6;background:linear-gradient(135deg,#d6efff,#ede0ff,#ffe7ef);animation:down 1.8s ease-in-out infinite;font:14px system-ui}span:nth-child(2){animation-delay:.2s}span:nth-child(3){animation-delay:.4s}
      @keyframes flow{to{background-position:200% 0}}@keyframes down{50%{transform:translateY(5px);opacity:.6}}
      @media(prefers-reduced-motion:reduce){*{animation:none!important}}
    </style><div class="wave"></div><svg viewBox="0 0 1200 46" preserveAspectRatio="none"><defs><linearGradient id="rainbow"><stop stop-color="#91cfff"/><stop offset=".5" stop-color="#d4beff"/><stop offset="1" stop-color="#ffcddb"/></linearGradient></defs><path stroke="url(#rainbow)" d="M0 15 Q150 0 300 15 T600 15 T900 15 T1200 15"/><path stroke="#96d7ff" d="M0 20 Q150 35 300 20 T600 20 T900 20 T1200 20"/><path stroke="#bce9dc" d="M0 25 Q150 10 300 25 T600 25 T900 25 T1200 25"/></svg><div class="arrows"><span>↓</span><span>↓</span><span>↓</span></div>`;
    document.documentElement.append(host);
  }
  host.hidden=true;
  globalThis.__gptusShowWave=()=>{
    host.hidden=false;
    clearTimeout(globalThis.__gptusWaveTimeout);
    globalThis.__gptusWaveTimeout=setTimeout(()=>{host.hidden=true;},1800);
  };
})();
