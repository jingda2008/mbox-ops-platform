(async()=>{
 const supported=['zh','en','ru','ja','ko','fr','de'];
 // Explicit language URLs never redirect. Manual choice takes priority next visit.
 if(new RegExp('^/('+supported.join('|')+')(/|$)').test(location.pathname))return;
 let chosen;try{const saved=localStorage.getItem('mbox.language');if(supported.includes(saved))chosen=saved;}catch{}
 if(!chosen){for(const preferred of navigator.languages||[navigator.language]){const code=String(preferred).toLowerCase().split('-')[0];if(supported.includes(code)){chosen=code;break;}}}
 if(!chosen){try{const response=await fetch('/api/language',{signal:AbortSignal.timeout(1500),cache:'no-store'});const data=await response.json();if(supported.includes(data.language))chosen=data.language;}catch{}}
 location.replace('/'+(chosen||'en')+'/'+location.search+location.hash);
})();
