(() => {
  // Isolated, click-through activity decoration: never replaces browser safety UI.
  let host=document.getElementById('__gptus_activity_wave');
  if(!host){
    host=document.createElement('div');host.id='__gptus_activity_wave';
    host.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483646';
    host.setAttribute('aria-hidden','true');
    const root=host.attachShadow({mode:'closed'});
    root.innerHTML=`<style>
      .field{position:absolute;inset:0;opacity:.48;background:radial-gradient(ellipse 60% 15% at 50% 100%,#6557ff36,transparent 85%),radial-gradient(ellipse 55% 13% at 50% 0%,#24d9ee2b,transparent 85%),radial-gradient(ellipse 12% 70% at 0% 50%,#a554ed22,transparent 80%),radial-gradient(ellipse 12% 70% at 100% 50%,#45d9d829,transparent 80%);animation:glow 2.8s ease-in-out infinite alternate}
      .rim{position:absolute;inset:0;border:2px solid transparent;border-image:linear-gradient(115deg,#b168ed88,#6d91ff88,#52e1e088,#ee87bd88,#b168ed88) 1;opacity:.68}
      svg{position:absolute;overflow:visible;filter:drop-shadow(0 0 7px #8d7bf888)}path{fill:none;stroke-width:2.4;opacity:.55;animation:flow 2.4s ease-in-out infinite alternate}path:nth-of-type(2){animation-delay:-.8s;opacity:.36}path:nth-of-type(3){animation-delay:-1.6s;opacity:.3}
      .edge{left:0;width:100%;height:58px}.top{top:0}.bottom{bottom:0;transform:rotate(180deg)}
      .side{top:0;height:100%;width:58px}.left{left:0}.right{right:0;transform:rotate(180deg)}.side path{stroke-width:2;opacity:.35;animation-name:sideflow}
      .mark{position:absolute;top:12px;left:50%;transform:translateX(-50%);width:45px;height:27px;border-radius:30px;border:1px solid #9579ec99;background:linear-gradient(110deg,#482866bb,#233681bb,#08465abb);box-shadow:0 0 13px #756be663;display:grid;place-items:center;color:#e2eeff;font:19px system-ui}
      .mark span{animation:nudge 1.5s ease-in-out infinite alternate}
      @keyframes flow{to{transform:translateY(9px) scaleY(.65)}}@keyframes sideflow{to{transform:translateX(8px) scaleX(.7)}}@keyframes glow{to{opacity:.76}}@keyframes nudge{to{transform:translateY(3px);opacity:.75}}
      @media(prefers-reduced-motion:reduce){*{animation:none!important}}
    </style><div class="field"></div><div class="rim"></div><svg class="edge top" viewBox="0 0 1200 58" preserveAspectRatio="none"><defs><linearGradient id="siri"><stop stop-color="#aa5fe9"/><stop offset=".24" stop-color="#737bfb"/><stop offset=".5" stop-color="#4ed9ea"/><stop offset=".76" stop-color="#e48abe"/><stop offset="1" stop-color="#aa5fe9"/></linearGradient></defs><path stroke="url(#siri)" d="M0 20 Q150 2 300 20 T600 20 T900 20 T1200 20"/><path stroke="#67bff0" d="M0 27 Q150 46 300 27 T600 27 T900 27 T1200 27"/><path stroke="#e8a6d9" d="M0 33 Q150 14 300 33 T600 33 T900 33 T1200 33"/></svg><svg class="edge bottom" viewBox="0 0 1200 58" preserveAspectRatio="none"><path stroke="#a872ea" d="M0 20 Q150 2 300 20 T600 20 T900 20 T1200 20"/><path stroke="#60d9e9" d="M0 29 Q150 46 300 29 T600 29 T900 29 T1200 29"/></svg><svg class="side left" viewBox="0 0 58 1200" preserveAspectRatio="none"><path stroke="#ae6bee" d="M20 0 Q2 150 20 300 T20 600 T20 900 T20 1200"/><path stroke="#6cbdff" d="M29 0 Q47 150 29 300 T29 600 T29 900 T29 1200"/></svg><svg class="side right" viewBox="0 0 58 1200" preserveAspectRatio="none"><path stroke="#60d9e9" d="M20 0 Q2 150 20 300 T20 600 T20 900 T20 1200"/><path stroke="#ec92c7" d="M29 0 Q47 150 29 300 T29 600 T29 900 T29 1200"/></svg><div class="mark"><span>⌄⌄</span></div>`;
    document.documentElement.append(host);
  }
  host.hidden=true;
  let effectsEnabled=true;
  if(typeof chrome!=='undefined'&&chrome.storage){
    chrome.storage.local.get(['activityEffectsEnabled']).then(value=>{effectsEnabled=value.activityEffectsEnabled!==false;if(!effectsEnabled)host.hidden=true;});
    chrome.storage.onChanged?.addListener((changes,area)=>{if(area==='local'&&changes.activityEffectsEnabled){effectsEnabled=changes.activityEffectsEnabled.newValue!==false;if(!effectsEnabled)host.hidden=true;}});
  }
  globalThis.__gptusShowWave=()=>{
    if(!effectsEnabled)return;
    host.hidden=false;
    clearTimeout(globalThis.__gptusWaveTimeout);
    globalThis.__gptusWaveTimeout=setTimeout(()=>{host.hidden=true;},1800);
  };
})();
