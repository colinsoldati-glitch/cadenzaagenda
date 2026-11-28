import { auth, db, ref, get, update, onValue, state, $, esc, genId, saveSession, showToast, formatShortDateFr, getEventMeta } from './config.js';
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, sendEmailVerification, sendPasswordResetEmail, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js';
import { language } from './i18n.js';
import { deleteToken } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-messaging.js';
import { mergeLegacyAbsences, absenceWrites } from './account-model.js';
const LEGACY='cadenza_legacy_profiles_v1';
const tr=(fr,en,de)=>({fr,en,de}[language]||fr);
const readLocal=k=>{try{return JSON.parse(localStorage.getItem(k)||'null');}catch{return null;}};
if(!localStorage.getItem(LEGACY))localStorage.setItem(LEGACY,JSON.stringify(readLocal('cadenza_session_v1')?.ensembles||{}));
const hints=readLocal(LEGACY)||{};
const keyOk=k=>typeof k==='string'&&/^[a-zA-Z0-9_-]{1,150}$/.test(k);
const val=async path=>(await get(ref(db,path))).val();
const path=(uid)=>`accounts/${uid}`;
export function currentUid(){return auth.currentUser?.uid;}
let busy=false;
export async function loadMemberships(){
  const uid=currentUid();if(!uid)throw Error('Not signed in');
  const links=await val(`${path(uid)}/memberships`)||{};
  const entries=await Promise.all(Object.entries(links).map(async ([ens,mid])=>{
    const [d,owner]=await Promise.all([val(`ensembles/${ens}`),val(`profileOwners/${ens}/${mid}`)]);
    const m=d?.members?.[mid];return m&&owner===uid?[ens,{memberId:mid,name:m.name,instrument:m.instrument,ensembleName:d.name}]:null;
  }));
  state.session.ensembles=Object.fromEntries(entries.filter(Boolean));
  const saved=readLocal(`cadenza_active_${uid}`);state.session.activeEnsembleId=state.session.ensembles[saved]?saved:Object.keys(state.session.ensembles)[0]||null;
  saveSession();return state.session.ensembles;
}
export async function claimProfile(ens,mid,newMember=null,newEnsemble=null){
  if(!keyOk(ens)||!keyOk(mid)||!currentUid())throw Error('Invalid membership');
  if(busy)throw Error(tr('Une récupération est déjà en cours.','Recovery already in progress.','Wiederherstellung läuft bereits.'));
  busy=true;const uid=currentUid();
  try{
    const [account,d,owner]=await Promise.all([val(path(uid)),val(`ensembles/${ens}`),val(`profileOwners/${ens}/${mid}`)]);
    const previous=account?.memberships?.[ens];
    if(previous&&previous!==mid&&d?.members?.[previous])throw Error(tr('Ce compte est déjà lié à un autre profil de cet ensemble.','This account already has a profile in this ensemble.','Dieses Konto ist bereits mit einem anderen Profil verbunden.'));
    if(owner&&owner!==uid)throw Error(tr('Ce profil est déjà rattaché à un autre compte. Contactez le responsable.','This profile belongs to another account. Contact the manager.','Dieses Profil gehört bereits zu einem anderen Konto.'));
    if(newEnsemble&&d)throw Error('Ensemble ID already exists');
    if(newMember&&d?.members?.[mid])throw Error('Member ID already exists');
    const m=newMember||newEnsemble?.members?.[mid]||d?.members?.[mid];if(!m)throw Error(tr('Profil introuvable.','Profile not found.','Profil nicht gefunden.'));
    const links={...(account?.memberships||{}),[ens]:mid};
    const canonical=account?.absences||{};
    const merged=previous===mid&&owner===uid?canonical:mergeLegacyAbsences(canonical,m.unavailabilities||{},ens,mid);
    const writes={ [`${path(uid)}/memberships/${ens}`]:mid,[`profileOwners/${ens}/${mid}`]:uid,[`${path(uid)}/revision`]:(account?.revision||0)+1 };
    if(newEnsemble){writes[`ensembles/${ens}`]=newEnsemble;newEnsemble.members[mid]={...m,...(Object.keys(merged).length?{unavailabilities:merged}:{})};}
    else if(newMember)writes[`ensembles/${ens}/members/${mid}`]={...m,...(Object.keys(merged).length?{unavailabilities:merged}:{})};
    // Preserve old keys on first import where possible; canonical additions and all replicas commit together.
    for(const [id,u] of Object.entries(merged))if(!canonical[id])writes[`${path(uid)}/absences/${id}`]=u;
    for(const [e,member] of Object.entries(links)){
      if(e===ens&&(newMember||newEnsemble))continue;
      const ed=e===ens?d:await val(`ensembles/${e}`);if(!ed?.members?.[member])continue;
      writes[`ensembles/${e}/members/${member}/unavailabilities`]=Object.keys(merged).length?merged:null;
    }
    await update(ref(db),writes);
    await loadMemberships();state.session.activeEnsembleId=ens;saveSession();
    renderRecoveryHints();return m;
  }finally{busy=false;}
}
export async function updateGlobalAbsences(changes){
  const uid=currentUid();if(!uid)throw Error('Not signed in');
  const account=await val(path(uid))||{},links=account.memberships||{};
  const valid={};await Promise.all(Object.entries(links).map(async ([ens,mid])=>{const [m,owner]=await Promise.all([val(`ensembles/${ens}/members/${mid}`),val(`profileOwners/${ens}/${mid}`)]);if(m&&owner===uid)valid[ens]=mid;}));
  await update(ref(db),{...absenceWrites(uid,valid,changes),[`${path(uid)}/revision`]:(account.revision||0)+1});
}
export async function unlinkEnsemble(ens){const uid=currentUid(),account=await val(path(uid))||{};await update(ref(db),{[`${path(uid)}/memberships/${ens}`]:null,[`${path(uid)}/revision`]:(account.revision||0)+1});}
let enterHook=()=>{}, onboardingHook=()=>{}, tabHook=()=>{};
export function registerAccountHooks(h){enterHook=h.enter;onboardingHook=h.onboarding;tabHook=h.tab;}
function renderRecoveryHints(){
  const box=$('account-recovery');if(!box)return;
  const items=Object.entries(hints).filter(([ens,s])=>keyOk(ens)&&keyOk(s?.memberId)&&!state.session.ensembles[ens]);
  box.innerHTML=items.length?`<h3>${esc(tr('Anciens profils sur cet appareil','Previous profiles on this device','Frühere Profile auf diesem Gerät'))}</h3><p>${esc(tr('Ne récupérez que vos propres profils.','Only recover your own profiles.','Nur eigene Profile wiederherstellen.'))}</p>`+items.map(([e,s])=>`<button type="button" class="btn-secondary btn-full" data-recover-ens="${esc(e)}">${esc(s.name)} · ${esc(s.ensembleName||e)}</button>`).join(''):'';
  box.classList.toggle('hidden',!items.length);
}
export function showAccountOverview(){
  if(!currentUid())return;
  state.unsubscribeEnsemble?.();state.unsubscribeEnsemble=null;state.currentEnsembleData=null;
  ['view-install-tuto','view-onboarding','view-agenda','view-avail','view-ensemble','app-header','app-nav'].forEach(id=>$(id).classList.add('hidden'));
  $('view-account').classList.remove('hidden');$('account-email').textContent=auth.currentUser.email||'';renderRecoveryHints();
  refreshOverview().catch(e=>{$('account-overview-list').textContent=e.message;});
}
export function hideAccountOverview(){$('view-account').classList.add('hidden');}
async function refreshOverview(){
  const uid=currentUid();const links=await loadMemberships();
  const data=await Promise.all(Object.entries(links).map(async ([id,s])=>({id,s,d:await val(`ensembles/${id}`)})));
  const now=new Date(),today=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const events=data.flatMap(({id,d})=>Object.values(d?.rehearsals||{}).filter(r=>r.date>=today).map(r=>({...r,ens:id,ensemble:d.name}))).sort((a,b)=>`${a.date}${a.startTime||''}`.localeCompare(`${b.date}${b.startTime||''}`));
  const pending=data.map(({id,s,d})=>({id,name:d?.name||id,count:Object.values(d?.polls||{}).filter(p=>p.date>=today&&!p.votes?.[s.memberId]).length}));
  $('account-overview-list').innerHTML=data.map(({id,s})=>`<button type="button" class="btn-secondary btn-full" data-account-open="${esc(id)}">${esc(s.ensembleName)} · ${esc(s.instrument)}</button>`).join('')||esc(tr('Aucun ensemble lié.','No linked ensembles.','Keine verknüpften Ensembles.'));
  $('account-events').innerHTML=events.map(r=>`<div class="member-row"><div><strong>${esc(formatShortDateFr(r.date))} · ${esc(getEventMeta(r.eventType).label)}</strong><div>${esc(r.ensemble)} · ${esc(r.startTime||'')} – ${esc(r.endTime||'')}</div><small>${esc(r.location||'')}</small></div><button type="button" class="btn-secondary" data-account-open="${esc(r.ens)}">${esc(tr('Ouvrir','Open','Öffnen'))}</button></div>`).join('')||esc(tr('Aucun événement à venir.','No upcoming events.','Keine kommenden Termine.'));
  $('account-pending').innerHTML=pending.map(p=>`<button type="button" class="btn-secondary btn-full" data-account-polls="${esc(p.id)}">${esc(p.name)} · ${p.count}</button>`).join('');
  const abs=await val(`${path(uid)}/absences`)||{};
  $('account-absences').innerHTML=Object.values(abs).sort((a,b)=>a.startDate.localeCompare(b.startDate)).map(a=>`<div class="member-row"><div>${esc(formatShortDateFr(a.startDate))} – ${esc(formatShortDateFr(a.endDate))}<small> ${esc(a.reason||'')}</small></div><button type="button" class="btn-secondary" data-account-delete="${esc(a.id)}">${esc(tr('Supprimer','Delete','Löschen'))}</button></div>`).join('');
  renderRecoveryHints();
}
export function initAccountUI(){
  $('btn-account-top').onclick=showAccountOverview;$('btn-open-transfer').textContent=tr('Mon compte et mes ensembles','My account and ensembles','Mein Konto und Ensembles');
  $('account-join').onclick=()=>{hideAccountOverview();['join-code-field','create-card','onboarding-divider'].forEach(id=>$(id).classList.remove('hidden'));$('join-code').value='';$('join-existing-members-box').classList.add('hidden');onboardingHook();};
  $('account-logout').onclick=async()=>{const b=$('account-logout');b.disabled=true;try{
    // Revoke this installation's FCM token on shared devices; other installations are unaffected.
    if(state.messagingInstance){try{await deleteToken(state.messagingInstance);}catch(err){if(!confirm(tr('Impossible de révoquer les notifications de cet appareil. Se déconnecter quand même ?','Could not revoke notifications for this device. Sign out anyway?','Benachrichtigungen konnten nicht widerrufen werden. Trotzdem abmelden?')))return;}}
    await signOut(auth);location.reload();
  }catch(e){showToast(e.message);}finally{b.disabled=false;}};
  $('account-refresh').onclick=()=>refreshOverview().catch(e=>showToast(e.message));
  $('account-absence-form').onsubmit=async e=>{e.preventDefault();const startDate=$('account-start').value,endDate=$('account-end').value,reason=$('account-reason').value.trim(),b=$('account-add-absence');if(!startDate||endDate<startDate)return showToast(tr('Dates invalides.','Invalid dates.','Ungültige Daten.'));b.disabled=true;try{const id=genId('una');await updateGlobalAbsences({[id]:{id,startDate,endDate,reason,createdAt:Date.now()}});e.target.reset();await refreshOverview();}catch(err){showToast(err.message);}finally{b.disabled=false;}};
  $('view-account').onclick=async e=>{const b=e.target.closest('button');if(!b)return;try{
    if(b.dataset.recoverEns){const id=b.dataset.recoverEns,s=hints[id];if(!confirm(tr(`Rattacher le profil ${s.name} à votre compte ?`,`Link ${s.name} to your account?`,`Profil ${s.name} mit deinem Konto verbinden?`)))return;b.disabled=true;await claimProfile(id,s.memberId);await refreshOverview();}
    if(b.dataset.accountOpen||b.dataset.accountPolls){const id=b.dataset.accountOpen||b.dataset.accountPolls;state.session.activeEnsembleId=id;saveSession();hideAccountOverview();enterHook(id);if(b.dataset.accountPolls)tabHook('avail');}
    if(b.dataset.accountDelete&&confirm(tr('Supprimer cette absence de tous vos ensembles ?','Delete this absence from all ensembles?','Abwesenheit aus allen Ensembles löschen?'))){b.disabled=true;await updateGlobalAbsences({[b.dataset.accountDelete]:null});await refreshOverview();}
  }catch(err){showToast(err.message);}finally{b.disabled=false;}};
  $('onboarding-account').onclick=showAccountOverview;
}
export async function requireAccount(){
  const screen=$('view-auth'), status=$('auth-status'), form=$('auth-form');screen.classList.remove('hidden');
  const setStatus=s=>status.textContent=s;
  const email=()=>$('auth-email').value.trim();const pass=()=>$('auth-password').value;
  const error=e=>{const messages={'auth/invalid-credential':tr('Adresse ou mot de passe incorrect.','Incorrect email or password.','E-Mail oder Passwort falsch.'),'auth/email-already-in-use':tr('Un compte existe déjà pour cette adresse. Connectez-vous ou réinitialisez le mot de passe.','An account already exists. Sign in or reset your password.','Ein Konto existiert bereits. Melde dich an oder setze das Passwort zurück.'),'auth/operation-not-allowed':tr('La connexion e-mail/mot de passe doit être activée dans Firebase.','Enable email/password sign-in in Firebase.','E-Mail/Passwort in Firebase aktivieren.')};setStatus(messages[e.code]||tr('Action impossible : ','Unable to continue: ','Aktion fehlgeschlagen: ')+(e.code||e.message));};
  return new Promise(resolve=>{
    let done=false, operating=false;
    const check=async user=>{if(done)return;if(!user){$('auth-verify-actions').classList.add('hidden');form.classList.remove('hidden');return;}
      if(!user.emailVerified){form.classList.add('hidden');$('auth-verify-actions').classList.remove('hidden');setStatus(tr('Confirmez votre adresse e-mail, puis cliquez sur « J’ai confirmé ».','Verify your email, then click “I verified”.','Bestätige deine E-Mail und klicke auf „Bestätigt“.'));return;}
      done=true;try{await user.getIdToken(true);await loadMemberships();screen.classList.add('hidden');resolve(user);}catch(e){done=false;error(e);$('auth-verify-actions').classList.remove('hidden');}
    };
    const action=fn=>async e=>{e?.preventDefault();if(operating)return;operating=true;try{await fn();}catch(err){error(err);}finally{operating=false;}};
    form.onsubmit=action(async()=>{await signInWithEmailAndPassword(auth,email(),pass());});
    $('auth-register').onclick=action(async()=>{if(!form.reportValidity())return;if(pass().length<8){setStatus(tr('8 caractères au minimum.','At least 8 characters.','Mindestens 8 Zeichen.'));return;}const c=await createUserWithEmailAndPassword(auth,email(),pass());await sendEmailVerification(c.user);});
    $('auth-reset').onclick=action(async()=>{if(!$('auth-email').reportValidity())return;try{await sendPasswordResetEmail(auth,email());}catch(err){if(err.code!=='auth/user-not-found')throw err;}setStatus(tr('Si ce compte existe, un e-mail de réinitialisation a été demandé.','If this account exists, a reset email was requested.','Falls das Konto existiert, wurde eine Reset-E-Mail angefordert.'));});
    $('auth-verified').onclick=action(async()=>{await auth.currentUser?.reload();await check(auth.currentUser);});
    $('auth-resend').onclick=action(async()=>{await sendEmailVerification(auth.currentUser);setStatus(tr('E-mail envoyé.','Email sent.','E-Mail gesendet.'));});
    $('auth-switch').onclick=action(async()=>{await signOut(auth);setStatus('');});
    onAuthStateChanged(auth,user=>{if(done){if(!user)location.reload();return;}check(user);},error);
  });
}
