(() => {
  const root = document.body;
  const language = root.dataset.language;
  const key = 'cadenza_language_v1';
  document.querySelectorAll('[data-language]').forEach(link => {
    if (link.tagName !== 'A') return;
    link.addEventListener('click', () => { try { localStorage.setItem(key, link.dataset.language); } catch (_) {} });
  });
  document.querySelectorAll('.app-link').forEach(link => link.addEventListener('click', () => {
    try { if (language !== 'fr' || !localStorage.getItem(key)) localStorage.setItem(key, language); } catch (_) {}
  }));
  const tabs = [...document.querySelectorAll('[data-demo-tab]')];
  function selectTab(i, focus = false) {
    tabs.forEach((tab,j) => { tab.setAttribute('aria-selected', String(i===j)); tab.tabIndex=i===j?0:-1; document.getElementById(`panel-${j}`).hidden=i!==j; });
    if (focus) tabs[i].focus();
  }
  tabs.forEach((tab,i) => {
    tab.addEventListener('click',()=>selectTab(i));
    tab.addEventListener('keydown',event=>{
      const next = ({ArrowRight:(i+1)%tabs.length,ArrowLeft:(i+tabs.length-1)%tabs.length,Home:0,End:tabs.length-1})[event.key];
      if (next!==undefined) {event.preventDefault();selectTab(next,true);}
    });
  });
  const labels=root.dataset.labels.split('|');
  const states=['yes','maybe','no','none'];
  const symbols=['✓','?','×','○'];
  const buttons=[...document.querySelectorAll('[data-vote]')];
  function vote(value) {
    const i=states.indexOf(value);
    buttons.forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.vote===value)));
    document.querySelector('[data-own-segment]').className=value;
    document.querySelector('[data-count]').textContent=value==='yes'?'4':'3';
    const cell=document.querySelector('[data-matrix-you]');cell.className=`state ${value}`;cell.textContent=symbols[i];cell.title=labels[i];cell.setAttribute('aria-label',labels[i]);
    document.querySelector('[data-matrix-total]').textContent=value==='yes'?'4/4':'3/4';
    document.querySelector('.feedback').textContent=value==='none'?root.dataset.none:root.dataset.saved;
  }
  buttons.forEach(b=>b.addEventListener('click',()=>vote(b.getAttribute('aria-pressed')==='true'?'none':b.dataset.vote)));
  document.querySelector('.reset-demo').addEventListener('click',()=>{vote('none');selectTab(0);});
  function openPrivacy(){if(location.hash==='#privacy')document.getElementById('privacy').open=true;}
  addEventListener('hashchange',openPrivacy);openPrivacy();
})();
